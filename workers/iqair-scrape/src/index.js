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

async function firecrawlScrape(url, key, timeoutMs = 40000) {
  // Hard per-request timeout: a single slow/hung IQAir render can no longer hold
  // the fetch open indefinitely (which, across the batch, used to push the cron
  // invocation past its execution budget). On timeout the fetch aborts → this
  // station fails gracefully this run and self-heals next run.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
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
      signal: ctrl.signal,
    });
    let j = {};
    try { j = await r.json(); } catch {}
    return { status: r.status, html: (j.data || {}).rawHtml || '', ok: !!j.success };
  } finally {
    clearTimeout(timer);
  }
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
      iqair_url=excluded.iqair_url,
      -- COALESCE the IDENTITY fields: the DOM fallback (for IQAir pages migrated
      -- off SSR streaming) recovers the current reading but not coordinates or
      -- provenance, so a plain excluded.* would null out lat/lon and blank the
      -- map pin. Keep the last good identity when the new scrape lacks it; the
      -- READING fields still update every scrape so the station stays live.
      name=COALESCE(excluded.name, iq_scrape_stations.name),
      lat=COALESCE(excluded.lat, iq_scrape_stations.lat),
      lon=COALESCE(excluded.lon, iq_scrape_stations.lon),
      source_type=COALESCE(excluded.source_type, iq_scrape_stations.source_type),
      source_subtype=COALESCE(excluded.source_subtype, iq_scrape_stations.source_subtype),
      contributor=COALESCE(excluded.contributor, iq_scrape_stations.contributor),
      latest_pm25=excluded.latest_pm25,
      latest_aqi=excluded.latest_aqi,
      latest_ts=COALESCE(excluded.latest_ts, iq_scrape_stations.latest_ts),
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
      // Mark the attempt failed but DO NOT advance last_scrape_ts — it must keep
      // pointing at the last SUCCESSFUL scrape so /api/live's staleness check
      // (FRESH_MS) correctly flags the station stale when scraping is failing,
      // instead of masking a stuck scraper as freshly-updated.
      await db.prepare(`UPDATE iq_scrape_stations SET last_scrape_ok=0 WHERE slug=?1`)
        .bind(slug).run().catch(() => {});
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

// Bounded-concurrency pool with a global soft deadline. Results come back in
// input order; any item not STARTED before the deadline is marked {skipped}.
// Crucially, only `concurrency` fetches are ever in flight at once and we stop
// launching new ones past the deadline — so the invocation always finishes
// cleanly (writing whatever completed) instead of being killed mid-flight.
async function runPool(items, worker, { concurrency, deadlineMs }) {
  const results = new Array(items.length);
  const start = Date.now();
  let next = 0;
  async function lane() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      if (Date.now() - start > deadlineMs) { results[i] = { skipped: true }; continue; }
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

// Rotation: the 10 stations are split into 4 groups, one scraped per 15-min cron
// tick (:07/:22/:37/:52). Each station is still scraped once an hour, but each
// invocation only does ≤3 stations (~50s) — comfortably under the Worker budget,
// so a slow Firecrawl window can no longer push a run over its limit. A missed
// station self-heals next cycle (UPSERT + the page's 48h hourly backstop).
const STATION_GROUPS = [[0, 1, 2], [3, 4, 5], [6, 7], [8, 9]];
function groupForScheduledTime(scheduledTime) {
  const min = scheduledTime ? new Date(scheduledTime).getUTCMinutes() : 0;
  return STATION_GROUPS[Math.floor(min / 15) % STATION_GROUPS.length];
}

// Run the scrape.
//   opts.onlySlug  → single station (fast manual verification)
//   opts.group     → array of STATION indices (rotation subset for a cron tick)
//   neither        → all 10 (manual full run / backfill)
async function runAll(env, opts = {}) {
  const { onlySlug = null, group = null } = opts;
  const key = env.FIRECRAWL_KEY;
  const db = env.ARCHIVE_DB;
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  if (!key) return { error: 'no_firecrawl_key' };
  if (!db) return { error: 'no_d1_binding' };

  let targets;
  if (onlySlug) targets = STATIONS.filter(([s]) => s === onlySlug);
  else if (group) targets = group.map((i) => STATIONS[i]).filter(Boolean);
  else targets = STATIONS;
  if (!targets.length) return { error: 'unknown_slug', slug: onlySlug };

  // Firecrawl allows only 2 concurrent scrapes (account maxConcurrency=2). Match
  // it with a pool of 2 so nothing queues on Firecrawl's side, and cap each run
  // with a soft deadline as a backstop.
  const summary = await runPool(
    targets,
    ([slug, url]) => processStation(db, slug, url, key, nowSec),
    { concurrency: 2, deadlineMs: onlySlug ? 60000 : 200000 }
  );

  const okCount = summary.filter((s) => s && s.ok).length;
  const failCount = summary.filter((s) => s && s.ok === false).length;
  const skipCount = summary.filter((s) => s && s.skipped).length;
  const durationMs = Date.now() - t0;

  // Run log — so a future stall is visible (ok/fail/skip per run) WITHOUT needing
  // a manual trigger to discover it. Best-effort; never fails the run.
  try {
    const detail = targets.map(([slug], i) => {
      const s = summary[i];
      if (!s) return `${slug}:none`;
      if (s.skipped) return `${slug}:skip`;
      return `${slug}:${s.ok ? 'ok' : (s.error || s.reason || ('http' + s.http) || 'fail')}`;
    });
    await db.prepare(`
      INSERT INTO iq_scrape_runs (ts, duration_ms, ok_count, fail_count, skip_count, detail)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).bind(nowSec, durationMs, okCount, failCount, skipCount, JSON.stringify(detail).slice(0, 1800)).run();
  } catch (_) { /* never fail the run on log write */ }

  return { ran: nowSec, count: summary.length, ok: okCount, fail: failCount, skip: skipCount, durationMs, stations: summary };
}

export default {
  async scheduled(event, env, ctx) {
    // Each 15-min tick scrapes one rotating group (≤3 stations), so a single
    // invocation stays small and can't be killed mid-batch by a slow window.
    ctx.waitUntil(runAll(env, { group: groupForScheduledTime(event && event.scheduledTime) }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/watchdog') {
      // Cross-worker watchdog/scheduler — called by nafas-archive when scrapes
      // look stale. Needed because Cloudflare CPU-kills this worker's SCHEDULED
      // invocations (June 12: every cron tick died "Exceeded CPU Limit" before
      // writing anything) while identical work via HTTP invocations succeeds.
      // Gated by a dedicated shared secret header — never the Firecrawl key.
      const want = env.IQAIR_WATCHDOG_KEY;
      if (!want || request.headers.get('X-Watchdog-Key') !== want) {
        return new Response('forbidden', { status: 403 });
      }
      // Pick the STALEST rotation group server-side (caller sends no input):
      // per group, freshness = its most recently scraped station; scrape the
      // group whose freshness is oldest. UPSERTs make any overlap harmless.
      const db = env.ARCHIVE_DB;
      let groupIdx = 0;
      try {
        const rows = await db.prepare(
          `SELECT slug, last_scrape_ts FROM iq_scrape_stations WHERE active = 1`
        ).all();
        const bySlug = new Map((rows.results || []).map(r => [r.slug, r.last_scrape_ts || 0]));
        let oldest = Infinity;
        STATION_GROUPS.forEach((idxs, gi) => {
          const newest = Math.max(...idxs.map(i => bySlug.get(STATIONS[i] && STATIONS[i][0]) || 0));
          if (newest < oldest) { oldest = newest; groupIdx = gi; }
        });
      } catch (_) { /* default group 0 */ }
      const out = await runAll(env, { group: STATION_GROUPS[groupIdx] });
      return new Response(JSON.stringify({ via: 'watchdog', group: groupIdx, ...out }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/run') {
      // Gated manual trigger: require the caller to know the key prefix.
      const want = (env.FIRECRAWL_KEY || '').slice(0, 8);
      if (!want || url.searchParams.get('key') !== want) {
        return new Response('forbidden', { status: 403 });
      }
      // ?slug=<one> verifies a single station fast; otherwise a full 10-station
      // run (manual backfill / post-deploy sanity check).
      const onlySlug = url.searchParams.get('slug') || null;
      const out = await runAll(env, { onlySlug });
      return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('iqair-scrape worker', { status: 200 });
  },
};
