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
import {
  parseCityLinks, parseStationLinks, parseStationCount, stationKey, stationUrl, cityUrl,
  slugFor, classifyCandidate, RECHECKABLE,
} from './discover.js';

// slug → IQAir station URL. Coords/name/contributor are pulled from each page
// at scrape time (no hardcoding). This is the hand-kept seed list; stations
// IQAir adds later are found by discovery (below) and scraped alongside these.
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
  // Added 2026-10-10. The hotel's own IQAir device: "Station from Seminyak
  // Beach - Hotel Indigo" (contributor type Hospitality, 1 station), IQAir
  // type 'station' with activeStationsCount 1, no relayed "Data sources", own
  // map position -8.6948,115.1620. Nearest station we publish is 627 m away
  // (Smart Citizen sc-19774), so it is its own pin.
  ['seminyak-beach-hotel-indigo', 'https://www.iqair.com/ca/indonesia/bali/badung/seminyak-beach-hotel-indigo'],
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

  // IQAir-supplied daily rows are AUTHORITATIVE: src=NULL marks them so the
  // hourly rollup below never overwrites them. If IQAir ever resumes supplying a
  // day we had rolled up ourselves, this path wins and clears the marker.
  const dailyStmt = db.prepare(
    `INSERT INTO iq_scrape_daily (slug, date, pm25, aqi, src) VALUES (?1,?2,?3,?4,NULL)
     ON CONFLICT(slug, date) DO UPDATE SET pm25=excluded.pm25, aqi=excluded.aqi, src=NULL`);
  for (const p of ex.daily) stmts.push(dailyStmt.bind(slug, p.ts, p.concentration, p.aqi));

  const monthlyStmt = db.prepare(
    `INSERT INTO iq_scrape_monthly (slug, month, pm25, aqi) VALUES (?1,?2,?3,?4)
     ON CONFLICT(slug, month) DO UPDATE SET pm25=excluded.pm25, aqi=excluded.aqi`);
  for (const p of ex.monthly) stmts.push(monthlyStmt.bind(slug, p.ts, p.concentration, p.aqi));

  if (stmts.length) await db.batch(stmts);

  // Keep the DAILY series alive for stations IQAir has migrated to client-side
  // rendering. Those pages no longer ship pre-computed daily aggregates (ex.daily
  // is empty), so without this a migrated station's 90d/All chart would freeze on
  // the migration date even though its hourly readings keep flowing. It's the
  // same physical sensor and the same slug — so we simply aggregate OUR hourly
  // points into the same table and the record continues unbroken.
  //
  // Scope is deliberately narrow: only when IQAir supplied no daily this scrape,
  // and only the last 3 WITA days. Grouping is by WITA day (+8h) to match how the
  // site reads a "daily mean", labelled with the same ISO-UTC-midnight key the
  // existing rows use.
  //
  // `WHERE src='rollup'` on the conflict clause is the safety rail: a computed
  // mean is only ever a mean of the hours WE happened to sample, so it must
  // never replace an IQAir full-day figure. Verified against villa-solaris,
  // whose Jul 18 authoritative 13.3 would otherwise have been overwritten by a
  // 12.8 derived from just 9 sampled hours. So: insert where no row exists
  // (gap-fill), refine our own rows as later hours arrive, never touch IQAir's.
  let rolledDaily = 0;
  if (!ex.daily.length) {
    try {
      // Window = WHOLE WITA days only: the current day plus the two before it.
      // A rolling wall-clock window (nowSec - 3*86400) is subtly wrong here: its
      // oldest day is a shrinking partial slice, and because our own rows ARE
      // updatable, each run would rewrite that already-settled day with fewer
      // and fewer samples until it froze at roughly the day's last hour —
      // ~2.2x high on evening-peaked burn data, i.e. biased exactly the wrong
      // way. Day-aligning the cutoff keeps every non-current day complete.
      // Comparing `ts` directly (not unixepoch(ts)) also keeps the query
      // sargable on idx_iq_hourly_slug_ts — this worker has been CPU-killed
      // before, so a growing full-scan per station per scrape is not affordable.
      const witaDayStart = Math.floor((nowSec + 28800) / 86400) * 86400 - 28800;
      const cutoffIso = new Date((witaDayStart - 2 * 86400) * 1000).toISOString();
      const r = await db.prepare(`
        INSERT INTO iq_scrape_daily (slug, date, pm25, aqi, src, n)
        SELECT ?1,
               date(datetime(unixepoch(ts) + 28800, 'unixepoch')) || 'T00:00:00.000Z' AS d,
               ROUND(AVG(pm25), 1),
               CAST(ROUND(AVG(aqi)) AS INTEGER),
               'rollup',
               COUNT(*)
        FROM iq_scrape_hourly
        WHERE slug = ?1 AND pm25 IS NOT NULL AND ts >= ?2
        GROUP BY d
        ON CONFLICT(slug, date) DO UPDATE SET
          pm25 = excluded.pm25,
          -- never let a NULL-aqi sample window blank an aqi we already have
          aqi  = COALESCE(excluded.aqi, iq_scrape_daily.aqi),
          n    = excluded.n
        WHERE iq_scrape_daily.src = 'rollup'
          -- structural guard: only ever replace a rollup row with one built
          -- from at least as many samples, so no future windowing mistake can
          -- degrade a settled day. COALESCE covers rows written before n existed.
          AND excluded.n >= COALESCE(iq_scrape_daily.n, 0)
      `).bind(slug, cutoffIso).run();
      rolledDaily = (r && r.meta && r.meta.changes) || 0;
    } catch (_) {
      // Best-effort — never fail the scrape. -1 distinguishes "rollup errored"
      // from "nothing to roll up" in the run log, so a persistent failure can't
      // hide behind an otherwise-ok run (this worker has stalled silently before).
      rolledDaily = -1;
    }
  }

  return { hourly: ex.hourly.length, daily: ex.daily.length, monthly: ex.monthly.length,
           rolledDaily,
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
    // A page that turned into an area value (e.g. a station URL redirected to
    // its city) is not ingested — the station goes stale instead (§8.5).
    if (ex && ex.rejected) return { slug, ok: false, reason: ex.rejected, http: status };
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

// The full scrape list: the seed STATIONS plus every station discovery has
// admitted (iq_discovery.status = 'active'). Before schema-v12 is applied the
// discovery table does not exist and this is simply STATIONS.
async function loadTargets(db) {
  const targets = STATIONS.map(([slug, url]) => [slug, url]);
  try {
    const rows = await db.prepare(
      `SELECT slug, url FROM iq_discovery WHERE status = 'active' AND slug IS NOT NULL
       ORDER BY first_seen, key`
    ).all();
    const have = new Set(targets.map(([s]) => s));
    for (const r of (rows.results || [])) {
      if (!have.has(r.slug)) { targets.push([r.slug, r.url]); have.add(r.slug); }
    }
  } catch (_) { /* no discovery table yet */ }
  return targets;
}

// Rotation: the stations are dealt round-robin into 4 groups, one scraped per
// 15-min cron tick (:07/:22/:37/:52). Each station is still scraped once an
// hour, but each invocation only does a quarter of them (≤3 today, ~50s) —
// comfortably under the Worker budget, so a slow Firecrawl window can no longer
// push a run over its limit. A missed station self-heals next cycle (UPSERT +
// the page's 48h hourly backstop). Computed, not hardcoded, so a discovered
// station joins a group without anyone editing an index list.
const GROUP_COUNT = 4;
function groupsFor(n) {
  const groups = Array.from({ length: GROUP_COUNT }, () => []);
  for (let i = 0; i < n; i++) groups[i % GROUP_COUNT].push(i);
  return groups;
}
function groupIndexForScheduledTime(scheduledTime) {
  const min = scheduledTime ? new Date(scheduledTime).getUTCMinutes() : 0;
  return Math.floor(min / 15) % GROUP_COUNT;
}

// Run the scrape.
//   opts.onlySlug  → single station (fast manual verification)
//   opts.groupIdx  → one rotation group (a cron tick / the watchdog)
//   neither        → every station (manual full run / backfill)
async function runAll(env, opts = {}) {
  const { onlySlug = null, groupIdx = null } = opts;
  const key = env.FIRECRAWL_KEY;
  const db = env.ARCHIVE_DB;
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  if (!key) return { error: 'no_firecrawl_key' };
  if (!db) return { error: 'no_d1_binding' };

  const all = await loadTargets(db);
  let targets;
  if (onlySlug) targets = all.filter(([s]) => s === onlySlug);
  else if (groupIdx != null) targets = (groupsFor(all.length)[groupIdx] || []).map((i) => all[i]);
  else targets = all;
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

// Reciprocal watchdog: revive nafas-archive if ITS cron has gone quiet.
//
// nafas-archive has revived THIS worker for a while; the relationship was
// one-way, so nothing watched the watcher. On 2026-08-30 nafas-archive's cron
// stopped firing for 25 hours and the only reason it surfaced was a contributor
// noticing his sensor's history had flatlined.
//
// The two crons are deliberately offset (this one at :07/:22/:37/:52, that one
// at :00/:15/:30/:45), so a failure confined to one worker is visible from the
// other. Be honest about the limit: both run on Cloudflare cron, so a
// platform-wide cron outage takes out watcher and watched together. This closes
// the per-worker case, which is the one that has actually bitten twice.
//
// 90 minutes = 6 consecutive missed 15-min ticks: long enough that a single
// slow or skipped tick never fires this, short enough to catch a real death
// within the hour rather than the day.
const ARCHIVE_STALE_MIN = 90;
async function reviveArchiveIfStale(env) {
  if (!env.NAFAS_ARCHIVE || !env.ARCHIVE_WATCHDOG_KEY) return null;
  try {
    const row = await env.ARCHIVE_DB.prepare(
      `SELECT MAX(ts) AS last_ts FROM archive_runs`
    ).first();
    if (!row || !row.last_ts) return null;
    const ageMin = (Math.floor(Date.now() / 1000) - row.last_ts) / 60;
    if (ageMin <= ARCHIVE_STALE_MIN) return null;
    const r = await env.NAFAS_ARCHIVE.fetch('https://nafas-archive.internal/watchdog', {
      method: 'POST',
      headers: { 'X-Watchdog-Key': env.ARCHIVE_WATCHDOG_KEY },
    });
    const note = `archive_watchdog_fired (last run ${Math.round(ageMin)}m ago, HTTP ${r.status})`;
    console.warn(note);
    return note;
  } catch (e) {
    console.warn('archive_watchdog_error: ' + (e.message || String(e)));
    return null;
  }
}

// ── Discovery ─────────────────────────────────────────────────────────────
// Finds IQAir stations in Bali that are not on the scrape list and admits the
// ones that prove, on their own page, that they are one native IQAir device
// (rules and reasons in discover.js). Runs on the :52 tick only and only AFTER
// that tick's scrape, so it never competes for Firecrawl's two concurrent
// slots, and it stops starting requests past its own deadline.
//
// Cost in steady state: the Bali page once a day, each of IQAir's ~40 Bali
// area pages once a week, and one page per new candidate — roughly 7 Firecrawl
// requests a day against ~260 for scraping. When the island's station count
// RISES (the cheap signal that something was added) every area page is queued
// at once and swept four per hourly tick, so a new station is normally admitted
// within about ten hours. That costs ~40 extra requests, at most once a day.
//
// Mode, env IQAIR_DISCOVERY: unset or 'auto' admits and starts scraping;
// 'review' records admissible stations as status 'review' for a person to
// promote to 'active'. ANY other value switches discovery off — a typo must
// never publish third-party devices.
//
// Operator overrides live in D1 (schema-v12): set iq_discovery.status to
// 'blocked' to keep a station out for good (and iq_scrape_stations.active = 0
// to take an admitted one off the map), or to 'active' to admit one by hand.
const DISCOVERY = {
  stateUrl: 'https://www.iqair.com/ca/indonesia/bali',
  stateEveryS: 23 * 3600,   // ~daily; the slack lets it land on whichever :52 tick comes first
  cityRescanS: 7 * 86400,
  cityRetryS: 86400,        // an area page that failed is tried again a day later, not next tick
  recheckS: 7 * 86400,      // how soon a recheckable rejection is looked at again
  citiesPerTick: 4,
  candidatesPerTick: 2,
  maxAttempts: 3,
  knownWindowS: 30 * 86400, // a station that reported within this window counts as present
  deadlineMs: 150000,
};
const DISCOVERY_GROUP = 3;  // the :52 tick

function discoveryMode(env) {
  const raw = env.IQAIR_DISCOVERY == null ? '' : String(env.IQAIR_DISCOVERY).trim().toLowerCase();
  if (raw === '' || raw === 'auto') return 'auto';
  if (raw === 'review') return 'review';
  return 'off';
}

// A Firecrawl request that never throws: its own 40 s abort becomes an
// ordinary failure, so one hung page costs one attempt instead of ending the
// pass (and, being first in line again next tick, every pass after it).
async function scrapeQuietly(url, key) {
  try { return await firecrawlScrape(url, key); }
  catch (e) { return { status: 'error ' + String(e && e.name || e).slice(0, 40), html: '', ok: false }; }
}

// Every position we publish that is still REPORTING (any network), for the
// co-location test. A dead station — an IQAir page that now 404s, a device that
// went quiet months ago — does not hold its spot against a new device there.
async function loadKnownPositions(db, nowSec) {
  const since = nowSec - DISCOVERY.knownWindowS;
  const a = await db.prepare(
    `SELECT station_id AS id, lat, lon FROM stations WHERE last_seen >= ?1`
  ).bind(since).all();
  const b = await db.prepare(
    `SELECT 'iqs-' || slug AS id, lat, lon FROM iq_scrape_stations
     WHERE active = 1 AND lat IS NOT NULL
       AND (latest_ts >= ?1 OR (latest_ts IS NULL AND last_scrape_ok = 1 AND last_scrape_ts >= ?2))`
  ).bind(new Date(since * 1000).toISOString(), since).all();
  return [...(a.results || []), ...(b.results || [])]
    .map(r => ({ id: r.id, lat: +r.lat, lon: +r.lon }));
}

async function discoveryTick(env, opts = {}) {
  const mode = discoveryMode(env);
  if (mode === 'off') return { discovery: 'off' };
  const db = env.ARCHIVE_DB, key = env.FIRECRAWL_KEY;
  if (!db || !key) return { error: 'not_configured' };
  const t0 = Date.now(), nowSec = Math.floor(t0 / 1000);
  const maxCities = opts.maxCities ?? DISCOVERY.citiesPerTick;
  const maxCandidates = opts.maxCandidates ?? DISCOVERY.candidatesPerTick;
  const late = () => Date.now() - t0 > DISCOVERY.deadlineMs;
  const log = [];
  let stateCount = null, citiesScanned = 0, checked = 0, added = 0;
  const seedKeys = new Set(STATIONS.map(([, url]) => stationKey(url)).filter(Boolean));

  try {
    // 1. The Bali page: the list of areas, and the island's station count.
    const last = await db.prepare(
      `SELECT ts, state_count FROM iq_discovery_runs WHERE state_count IS NOT NULL ORDER BY ts DESC LIMIT 1`
    ).first();
    const cityRow = await db.prepare(`SELECT COUNT(*) AS n FROM iq_discovery_cities`).first();
    const stateDue = opts.forceState || !cityRow || !cityRow.n || !last ||
                     nowSec - last.ts >= DISCOVERY.stateEveryS;
    if (stateDue) {
      const page = await scrapeQuietly(DISCOVERY.stateUrl, key);
      if (page.ok && page.html) {
        const cities = parseCityLinks(page.html);
        stateCount = parseStationCount(page.html);
        if (cities.size) {
          await db.batch([...cities].map(c => db.prepare(
            `INSERT OR IGNORE INTO iq_discovery_cities (city, last_scanned) VALUES (?1, 0)`
          ).bind(c)));
        }
        // Only a RISE means something was added; a fall is a station going
        // quiet, which the weekly sweep covers. One sweep per day at most.
        if (stateCount != null && last && stateCount > last.state_count) {
          await db.prepare(`UPDATE iq_discovery_cities SET last_scanned = 0`).run();
          log.push(`count ${last.state_count}->${stateCount}: sweeping every area page`);
        }
        log.push(`state: ${cities.size} areas, ${stateCount == null ? '?' : stateCount} stations`);
      } else {
        log.push(`state: ${page.status}`);
      }
    }

    // 2. Due area pages (never scanned, queued by a count rise, or a week old).
    const due = await db.prepare(
      `SELECT city FROM iq_discovery_cities WHERE last_scanned < ?1
       ORDER BY last_scanned ASC, city LIMIT ?2`
    ).bind(nowSec - DISCOVERY.cityRescanS, maxCities).all();
    for (const { city } of (due.results || [])) {
      if (late()) { log.push('deadline'); break; }
      const page = await scrapeQuietly(cityUrl(city), key);
      if (!page.ok || !page.html) {
        // Back off a day, so a page that keeps failing cannot hold a slot every tick.
        await db.prepare(`UPDATE iq_discovery_cities SET last_scanned = ?2 WHERE city = ?1`)
          .bind(city, nowSec - DISCOVERY.cityRescanS + DISCOVERY.cityRetryS).run();
        log.push(`${city}: ${page.status}`);
        continue;
      }
      const keys = [...parseStationLinks(page.html)];
      const fresh = keys.filter(k => !seedKeys.has(k));
      const stmts = fresh.map(k => db.prepare(
        `INSERT OR IGNORE INTO iq_discovery (key, url, status, first_seen) VALUES (?1, ?2, 'candidate', ?3)`
      ).bind(k, stationUrl(k), nowSec));
      stmts.push(db.prepare(
        `UPDATE iq_discovery_cities SET last_scanned = ?2, stations_seen = ?3 WHERE city = ?1`
      ).bind(city, nowSec, keys.length));
      await db.batch(stmts);
      citiesScanned++;
    }

    // 3. Candidates: new ones first, then rejections whose reason can change.
    const recheckable = [...RECHECKABLE].map(r => `'${r}'`).join(',');
    const cands = await db.prepare(
      `SELECT key, url, attempts FROM iq_discovery
       WHERE status = 'candidate'
          OR (status = 'rejected' AND reason IN (${recheckable}) AND checked_at < ?1)
       ORDER BY (status = 'candidate') DESC, first_seen, key LIMIT ?2`
    ).bind(nowSec - DISCOVERY.recheckS, maxCandidates).all();
    let known = null;
    for (const c of (cands.results || [])) {
      if (late()) { log.push('deadline'); break; }
      checked++;
      const page = await scrapeQuietly(c.url, key);
      if (!page.ok || !page.html) {
        const attempts = (c.attempts || 0) + 1;
        const giveUp = attempts >= DISCOVERY.maxAttempts;
        await db.prepare(
          `UPDATE iq_discovery SET attempts = ?2, checked_at = ?3,
             status = CASE WHEN ?4 THEN 'rejected' ELSE status END,
             reason = CASE WHEN ?4 THEN 'fetch_failed' ELSE reason END
           WHERE key = ?1`
        ).bind(c.key, attempts, nowSec, giveUp ? 1 : 0).run();
        log.push(`${c.key}: fetch_failed (${page.status})`);
        continue;
      }
      if (!known) known = await loadKnownPositions(db, nowSec);
      const v = classifyCandidate(page.html, known, Date.now());
      if (v.verdict !== 'admit') {
        await db.prepare(
          `UPDATE iq_discovery SET status = 'rejected', reason = ?2, detail = ?3, checked_at = ?4,
             attempts = attempts + 1 WHERE key = ?1`
        ).bind(c.key, v.reason, v.detail || null, nowSec).run();
        log.push(`${c.key}: ${v.reason}${v.detail ? ' (' + v.detail + ')' : ''}`);
        continue;
      }
      // Admit. Never reuse a slug any station has ever had, or one already
      // assigned to any discovery row (review/blocked included): history is
      // keyed on it, and iq_discovery.slug is UNIQUE.
      const taken = new Set((await loadTargets(db)).map(([s]) => s));
      const prior = await db.prepare(
        `SELECT slug FROM iq_scrape_stations UNION SELECT slug FROM iq_discovery WHERE slug IS NOT NULL`
      ).all();
      for (const r of (prior.results || [])) taken.add(r.slug);
      const slug = slugFor(c.key, taken);
      const status = mode === 'review' ? 'review' : 'active';
      await db.prepare(
        `UPDATE iq_discovery SET status = ?2, slug = ?3, name = ?4, lat = ?5, lon = ?6, contributor = ?7,
           reason = NULL, detail = ?8, checked_at = ?9, decided_at = ?9 WHERE key = ?1`
      ).bind(c.key, status, slug, v.ex.name || null, v.ex.lat, v.ex.lon, v.contributor || null,
             v.nearest ? `nearest ${v.nearest}` : null, nowSec).run();
      // Ingest the page we already hold, so the station is live straight away.
      if (status === 'active') await ingestStation(db, slug, c.url, v.ex, nowSec);
      // It now holds its spot for the rest of this pass too: a second device
      // 40 m away, evaluated next, must be refused exactly as it would be on a
      // later tick.
      known.push({ id: 'iqs-' + slug, lat: v.ex.lat, lon: v.ex.lon });
      added++;
      log.push(`${c.key}: ${status} as iqs-${slug}`);
    }
  } catch (e) {
    log.push('error: ' + String(e && e.message || e).slice(0, 200));
  }

  const durationMs = Date.now() - t0;
  try {
    await db.prepare(
      `INSERT INTO iq_discovery_runs (ts, duration_ms, state_count, cities_scanned, candidates_checked, added, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(nowSec, durationMs, stateCount, citiesScanned, checked, added, JSON.stringify(log).slice(0, 1800)).run();
  } catch (_) { /* table missing until schema-v12 is applied */ }
  const line = 'iqair discovery: ' + log.join(' | ');
  if (log.some(l => l.startsWith('error') || l === 'deadline' || / (?:error|http\d|fetch_failed)/.test(l))) console.warn(line);
  else if (added) console.log(line);
  return { ran: nowSec, durationMs, mode, stateCount, citiesScanned, candidatesChecked: checked, added, log };
}

export default {
  async scheduled(event, env, ctx) {
    // Each 15-min tick scrapes one rotating group (a quarter of the stations),
    // so a single invocation stays small and can't be killed mid-batch by a
    // slow window. Discovery follows the :52 tick's scrape, never overlaps it.
    const groupIdx = groupIndexForScheduledTime(event && event.scheduledTime);
    ctx.waitUntil((async () => {
      await runAll(env, { groupIdx });
      if (groupIdx === DISCOVERY_GROUP) await discoveryTick(env);
    })());
    // Runs alongside, not inside, the scrape: a hung or CPU-killed scrape must
    // not also disable the archive's only automatic recovery path.
    ctx.waitUntil(reviveArchiveIfStale(env));
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
        const all = await loadTargets(db);
        const rows = await db.prepare(
          `SELECT slug, last_scrape_ts FROM iq_scrape_stations WHERE active = 1`
        ).all();
        const bySlug = new Map((rows.results || []).map(r => [r.slug, r.last_scrape_ts || 0]));
        let oldest = Infinity;
        groupsFor(all.length).forEach((idxs, gi) => {
          if (!idxs.length) return;
          const newest = Math.max(...idxs.map(i => bySlug.get(all[i][0]) || 0));
          if (newest < oldest) { oldest = newest; groupIdx = gi; }
        });
      } catch (_) { /* default group 0 */ }
      const out = await runAll(env, { groupIdx });
      return new Response(JSON.stringify({ via: 'watchdog', group: groupIdx, ...out }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/run') {
      // Gated manual trigger: require the caller to know the key prefix.
      const want = (env.FIRECRAWL_KEY || '').slice(0, 8);
      if (!want || url.searchParams.get('key') !== want) {
        return new Response('forbidden', { status: 403 });
      }
      // ?slug=<one> verifies a single station fast; otherwise every station
      // (manual backfill / post-deploy sanity check).
      const onlySlug = url.searchParams.get('slug') || null;
      const out = await runAll(env, { onlySlug });
      return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/discover') {
      // Gated manual discovery pass (same gate as /run). ?state=1 re-reads the
      // Bali page now; ?cities=N / ?candidates=N widen this one pass (capped).
      const want = (env.FIRECRAWL_KEY || '').slice(0, 8);
      if (!want || url.searchParams.get('key') !== want) {
        return new Response('forbidden', { status: 403 });
      }
      const n = (p, d, max) => Math.min(Math.max(parseInt(url.searchParams.get(p) || '', 10) || d, 0), max);
      const out = await discoveryTick(env, {
        forceState: url.searchParams.get('state') === '1',
        maxCities: n('cities', DISCOVERY.citiesPerTick, 12),
        maxCandidates: n('candidates', DISCOVERY.candidatesPerTick, 6),
      });
      return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('iqair-scrape worker', { status: 200 });
  },
};
