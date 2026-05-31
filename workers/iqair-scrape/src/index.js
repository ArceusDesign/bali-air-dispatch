// IQAir station scraper worker (hourly cron).
//
// For each configured station: render the IQAir page through Firecrawl, decode
// the page's own streamed payload (see extract.js — no IQAir API is called),
// then UPSERT current PM2.5 + hourly/daily/monthly history into D1.
//
// Design notes:
//  • UPSERT by (slug, ts/date/month) → re-scraping the same window is idempotent;
//    no duplicate rows, and a missed hourly run self-heals from the 48h window.
//  • One station failing never aborts the batch (per-station try/catch).
//  • A manual run is exposed at GET /run?key=<FIRECRAWL_KEY-prefix> for testing
//    (gated; returns a per-station summary, never echoes the key).
//  • All PM2.5 values are µg/m³; timestamps are IQAir's ISO-8601 UTC strings.

import { extractStation } from './extract.js';

// slug → IQAir station URL. Coords/name/contributor are pulled from each page
// at scrape time (no hardcoding), so this list is the only thing to maintain.
const STATIONS = [
  ['lycee-francais-de-bali',     'https://www.iqair.com/ca/indonesia/bali/badung/lycee-francais-de-bali'],
  ['villa-solaris',              'https://www.iqair.com/ca/indonesia/bali/nusa-dua/villa-solaris'],
  ['jimbaran-s',                 'https://www.iqair.com/ca/indonesia/bali/jimbaran/jimbaran-s'],
  ['sidakarya',                  'https://www.iqair.com/ca/indonesia/bali/denpasar/sidakarya'],
  ['imbo-inda-regency',          'https://www.iqair.com/ca/indonesia/bali/badung/imbo-inda-regency'],
  ['rock-n-love-3',              'https://www.iqair.com/ca/indonesia/bali/badung/rock-n-love-3'],
  ['bali-umalas-villa-fusion',   'https://www.iqair.com/ca/indonesia/bali/denpasar/bali-umalas-villa-fusion'],
  ['kabupaten-badung-sempidi',   'https://www.iqair.com/ca/indonesia/bali/badung/kabupaten-badung-sempidi'],
  ['gg-merdeka',                 'https://www.iqair.com/ca/indonesia/bali/sukasada/gg-merdeka'],
  ['plataran-menjangan',         'https://www.iqair.com/ca/indonesia/bali/buleleng/plataran-menjangan-resort-spa'],
];

async function firecrawlScrape(url, key) {
  const r = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    // maxAge:0 forces a FRESH fetch every time. Firecrawl v2 caches scrapes by
    // default (maxAge defaults to ~2 days), so without this every hourly run was
    // handed the SAME stale cached page — IQAir values were frozen hours behind
    // the live tile (verified: default scrape returned 06:00 UTC data at 14:13
    // UTC; maxAge:0 returned the live 13:00 UTC reading). We scrape hourly and
    // need each run to reflect the latest completed hour, so never use the cache.
    body: JSON.stringify({ url, formats: ['rawHtml'], waitFor: 9000, onlyMainContent: false, maxAge: 0 }),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  return { status: r.status, html: (j.data || {}).rawHtml || '', ok: !!j.success };
}

async function ingestStation(db, slug, url, ex, nowSec) {
  // Upsert station identity + latest snapshot.
  // Use the LAST COMPLETED HOUR for value + AQI + timestamp together, so the
  // stored reading and its timestamp always come from the same point. (We used
  // to store the live-tile value ex.currentConcentration but stamp it with the
  // last hourly ts — a source mismatch: the tile is a rolling sub-hour number,
  // the hourly point is the completed-hour average. The site shows the
  // completed-hour value, so read both from `latest`.) Falls back to the tile
  // only if a page somehow has no hourly series at all.
  const latest = ex.hourly.length ? ex.hourly[ex.hourly.length - 1] : null;
  const latestPm25 = latest && latest.concentration != null ? latest.concentration : ex.currentConcentration;
  const latestAqi  = latest && latest.aqi != null ? latest.aqi : ex.currentAqi;
  await db.prepare(`
    INSERT INTO iq_scrape_stations
      (slug, iqair_url, name, lat, lon, source_type, source_subtype, contributor,
       latest_pm25, latest_aqi, latest_ts, last_scrape_ts, last_scrape_ok, first_seen, active)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?12,1)
    ON CONFLICT(slug) DO UPDATE SET
      iqair_url=excluded.iqair_url, name=excluded.name, lat=excluded.lat, lon=excluded.lon,
      source_type=excluded.source_type, source_subtype=excluded.source_subtype,
      contributor=excluded.contributor, latest_pm25=excluded.latest_pm25,
      latest_aqi=excluded.latest_aqi, latest_ts=excluded.latest_ts,
      last_scrape_ts=excluded.last_scrape_ts, last_scrape_ok=1, active=1
  `).bind(
    slug, url, ex.name, ex.lat, ex.lon, ex.sourceType, ex.sourceSubType, ex.contributor,
    latestPm25, latestAqi, latest ? latest.ts : null, nowSec
  ).run();

  // Batched UPSERTs for each series.
  const stmts = [];
  const hourlyStmt = db.prepare(
    `INSERT INTO iq_scrape_hourly (slug, ts, pm25, aqi) VALUES (?1,?2,?3,?4)
     ON CONFLICT(slug, ts) DO UPDATE SET pm25=excluded.pm25, aqi=excluded.aqi`);
  for (const p of ex.hourly) stmts.push(hourlyStmt.bind(slug, p.ts, p.concentration, p.aqi));

  const dailyStmt = db.prepare(
    `INSERT INTO iq_scrape_daily (slug, date, pm25, aqi) VALUES (?1,?2,?3,?4)
     ON CONFLICT(slug, date) DO UPDATE SET pm25=excluded.pm25, aqi=excluded.aqi`);
  for (const p of ex.daily) stmts.push(dailyStmt.bind(slug, p.ts, p.concentration, p.aqi));

  const monthlyStmt = db.prepare(
    `INSERT INTO iq_scrape_monthly (slug, month, pm25, aqi) VALUES (?1,?2,?3,?4)
     ON CONFLICT(slug, month) DO UPDATE SET pm25=excluded.pm25, aqi=excluded.aqi`);
  for (const p of ex.monthly) stmts.push(monthlyStmt.bind(slug, p.ts, p.concentration, p.aqi));

  if (stmts.length) await db.batch(stmts);
  return { hourly: ex.hourly.length, daily: ex.daily.length, monthly: ex.monthly.length,
           pm25: ex.currentConcentration, name: ex.name, lat: ex.lat, lon: ex.lon };
}

// Scrape + ingest a single station. Returns a summary row (never throws).
async function processStation(db, slug, url, key, nowSec) {
  try {
    const { status, html, ok } = await firecrawlScrape(url, key);
    if (!ok || !html) {
      await db.prepare(`UPDATE iq_scrape_stations SET last_scrape_ts=?2, last_scrape_ok=0 WHERE slug=?1`)
        .bind(slug, nowSec).run().catch(() => {});
      return { slug, ok: false, http: status };
    }
    const ex = extractStation(html);
    if (!ex || (!ex.hourly.length && ex.currentConcentration == null)) {
      return { slug, ok: false, reason: 'no_data_parsed', http: status };
    }
    const r = await ingestStation(db, slug, url, ex, nowSec);
    return { slug, ok: true, ...r };
  } catch (e) {
    return { slug, ok: false, error: String(e && e.message || e) };
  }
}

// Run the scrape. `onlySlug` limits to one station (for low-latency manual
// verification). Stations are scraped in PARALLEL: the page render dominates
// wall-clock (~20-25s each), so sequential 10× would exceed the Worker limit;
// Promise.all keeps the whole batch close to a single station's latency.
async function runAll(env, onlySlug) {
  const key = env.FIRECRAWL_KEY;
  const db = env.ARCHIVE_DB;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!key) return { error: 'no_firecrawl_key' };
  if (!db) return { error: 'no_d1_binding' };

  const targets = onlySlug ? STATIONS.filter(([s]) => s === onlySlug) : STATIONS;
  if (!targets.length) return { error: 'unknown_slug', slug: onlySlug };

  const summary = await Promise.all(
    targets.map(([slug, url]) => processStation(db, slug, url, key, nowSec))
  );
  return { ran: nowSec, count: summary.length, stations: summary };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      // Gated manual trigger: require the caller to know the key prefix.
      const want = (env.FIRECRAWL_KEY || '').slice(0, 8);
      if (!want || url.searchParams.get('key') !== want) {
        return new Response('forbidden', { status: 403 });
      }
      // ?slug=<one> verifies a single station fast (avoids 10× latency).
      const onlySlug = url.searchParams.get('slug') || null;
      const out = await runAll(env, onlySlug);
      return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('iqair-scrape worker', { status: 200 });
  },
};
