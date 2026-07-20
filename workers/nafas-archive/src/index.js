// Cloudflare Worker — scheduled archive of Nafas Bali sensor data into D1.
//
// Runs on cron (every 15 min by default; see wrangler.toml [triggers]).
// Also exposes a /run endpoint for manual triggering (secret-gated).
//
// Data flow per tick:
//   1. GET https://outdoor.nafas.co.id/api/v1/location/all
//   2. Filter by Bali bbox → list of station UUIDs
//   3. Upsert into nafas_stations (catalog)
//   4. For each station, GET /api/v1/location/detail/{uuid} (parallel)
//   5. INSERT into nafas_snapshots (append-only, idempotent via PK)
//      UPSERT nafas_hourly from detail.measurement.hourly[]
//      UPSERT nafas_daily  from detail.measurement.daily[]
//   6. Append one row to archive_runs
//
// Idempotent by design: re-running the same tick is a no-op (all writes keyed).

const NAFAS_ALL    = 'https://outdoor.nafas.co.id/api/v1/location/all';
const NAFAS_DETAIL = (uuid) => `https://outdoor.nafas.co.id/api/v1/location/detail/${uuid}`;

// Bali bounding box — identical filter to functions/api/live.js
const BALI = { latMin: -9.2, latMax: -8.0, lonMin: 114.4, lonMax: 115.8 };

const HTTP = { 'Accept': 'application/json' };

function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}
function toIntOrNull(v) {
  const n = toNumberOrNull(v);
  return n == null ? null : Math.round(n);
}
function dateOnly(isoLike) {
  // Nafas daily rows use "from": "2026-04-01 00:00:00" style (Asia/Makassar).
  // We want YYYY-MM-DD.
  if (!isoLike) return null;
  const m = String(isoLike).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Parse an upstream `station_till` to unix-ms, WITA-aware (mirrors
// functions/api/live.js parseLastSeenMs): a timestamp with no zone is Nafas's
// "YYYY-MM-DD HH:MM:SS" in Asia/Makassar (UTC+8), so we append +08:00.
function parseTillMs(s) {
  if (!s) return null;
  let t = String(s).trim();
  if (t.includes(' ') && !t.includes('T')) t = t.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(t)) t = t + '+08:00';
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}
// Stop archiving a sensor's snapshots once its reading has been frozen/stale for
// longer than this. A short outage (≤ 48 h) still records, so the series stays
// continuous if the sensor recovers; a sensor stuck for days/months (e.g. a
// frozen AQICN echo) stops painting a fake flat line on the chart and stops
// inflating the "hours above WHO" counts. The catalog row is still upserted so
// the station stays listed (it just gathers no new data points).
const STALE_RECORD_MS = 48 * 60 * 60 * 1000;

async function fetchBaliStations() {
  const r = await fetch(NAFAS_ALL, { headers: HTTP });
  if (!r.ok) throw new Error(`Nafas /all HTTP ${r.status}`);
  const data = await r.json();
  if (!data?.success || !Array.isArray(data.body)) throw new Error('Nafas /all: unexpected shape');
  return data.body.filter(loc => {
    const lat = +loc.latitude, lon = +loc.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (loc.visible === false) return false;
    return lat >= BALI.latMin && lat <= BALI.latMax &&
           lon >= BALI.lonMin && lon <= BALI.lonMax;
  });
}

async function fetchDetail(uuid) {
  const r = await fetch(NAFAS_DETAIL(uuid), { headers: HTTP });
  if (!r.ok) return null;
  const data = await r.json();
  return data?.body || null;
}

async function upsertStation(db, loc, nowSec) {
  await db.prepare(`
    INSERT INTO nafas_stations (uuid, name, lat, lon, sponsor, vendor, first_seen, last_seen)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(uuid) DO UPDATE SET
      name = excluded.name,
      lat  = excluded.lat,
      lon  = excluded.lon,
      sponsor = excluded.sponsor,
      vendor  = excluded.vendor,
      last_seen = excluded.last_seen
  `).bind(
    loc.uuid,
    loc.name || `Nafas ${String(loc.uuid).slice(0,8)}`,
    +loc.latitude, +loc.longitude,
    loc.sponsor?.name || null,
    loc.vendor || null,
    nowSec
  ).run();
}

async function insertSnapshot(db, uuid, nowSec, detail) {
  // INSERT OR IGNORE — dedupe by (uuid, ts)
  await db.prepare(`
    INSERT OR IGNORE INTO nafas_snapshots
      (uuid, ts, station_till, pm25, pm10, pm1, aqi, temperature, humidity, pressure)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).bind(
    uuid, nowSec,
    detail.till || null,
    toNumberOrNull(detail.pm25),
    toNumberOrNull(detail.pm10),
    toNumberOrNull(detail.pm1),
    toIntOrNull(detail.aqi),
    toNumberOrNull(detail.temperature),
    toNumberOrNull(detail.humidity),
    toNumberOrNull(detail.pressure)
  ).run();
}

function buildHourlyStmt(db) {
  return db.prepare(`
    INSERT INTO nafas_hourly
      (uuid, hour_start, pm25, pm10, pm1, aqi, temperature, humidity, pressure)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(uuid, hour_start) DO UPDATE SET
      pm25 = excluded.pm25, pm10 = excluded.pm10, pm1 = excluded.pm1,
      aqi = excluded.aqi, temperature = excluded.temperature,
      humidity = excluded.humidity, pressure = excluded.pressure
  `);
}
function buildDailyStmt(db) {
  return db.prepare(`
    INSERT INTO nafas_daily
      (uuid, date, pm25, pm10, pm1, aqi, temperature, humidity, pressure)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(uuid, date) DO UPDATE SET
      pm25 = excluded.pm25, pm10 = excluded.pm10, pm1 = excluded.pm1,
      aqi = excluded.aqi, temperature = excluded.temperature,
      humidity = excluded.humidity, pressure = excluded.pressure
  `);
}

// ── Universal snapshot helpers (Edition III) ───────────────────────────
// Snapshot every station from /api/live into the universal tables, in
// addition to the Nafas-specific deep dive (hourly/daily aggregates).
async function fetchUnifiedLive(originBase) {
  // CF-to-CF fetch — calls our own /api/live aggregator from the worker.
  // originBase is set via env.LIVE_ORIGIN (defaults to baliair.pages.dev).
  //
  // CRITICAL: pass ?fresh=1 to BYPASS the D1 fast-path. Without this we
  // create a circular dependency — /api/live reads its most-recent snapshot
  // from D1, the worker writes that snapshot's stale values back into D1,
  // and live readings freeze. ?fresh=1 forces /api/live to call upstream
  // sources directly. Also disable the fetch's cf cache for the same reason.
  // The per-tick cache-buster is load-bearing, not belt-and-braces. /api/live
  // responds with `s-maxage=900, stale-while-revalidate=86400`, so the edge can
  // keep handing this worker a STALE copy for up to 24 h while it revalidates in
  // the background — `cf.cacheTtl: 0` does not prevent that. Observed 2026-07-20:
  // a newly-added source was serving on the origin for 20+ minutes while the
  // worker kept archiving a pre-deploy payload that omitted it. Archiving a
  // cached aggregate would also silently freeze readings, which is exactly the
  // failure ?fresh=1 exists to prevent. A unique query key forces a real miss.
  const url = (originBase || 'https://baliair.pages.dev').replace(/\/$/,'')
            + '/api/live?fresh=1&_cb=' + Date.now();
  const r = await fetch(url, {
    headers: { Accept:'application/json' },
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (!r.ok) throw new Error('live HTTP '+r.status);
  const data = await r.json();
  // SAFEGUARD #1: belt-and-braces check — if the response somehow returns
  // the fast-path payload despite ?fresh=1, throw rather than write a loop
  // back to D1. Better to skip a tick than freeze the archive.
  if (data && data.fast_path === true) {
    throw new Error('Worker received fast_path=true response (loop guard tripped)');
  }
  return data;
}

// SAFEGUARD #2 — stale-loop detector. v2: previous version compared pm25
// values which produced too many false positives (Airly/IQAir/AQICN report
// hourly so 3 of every 4 fifteen-minute snapshots will legitimately have
// the same pm25 — that's a plateau, not a freeze).
//
// Real loop signature: the upstream `station_till` timestamp is identical
// across MANY consecutive runs. During the Apr-27→May-2 freeze, every
// snapshot had till="2026-04-26..." regardless of when we wrote it.
//
// Detection: compute the most-common station_till across the just-written
// snapshots, and count how many distinct station_till values exist. If the
// run wrote >= 10 snapshots but only 1-2 distinct till values appeared,
// upstream isn't refreshing — likely a loop.
async function detectStaleLoop(db, currentTs) {
  try {
    const r = await db.prepare(`
      SELECT COUNT(*) AS total,
             COUNT(DISTINCT station_till) AS distinct_tills
      FROM station_snapshots
      WHERE ts = ?1 AND station_till IS NOT NULL
    `).bind(currentTs).first();
    return r;  // {total, distinct_tills}
  } catch (_) { return null; }
}

async function snapshotUniversal(db, live, nowSec) {
  if (!live?.stations?.length) return { stationsSeen:0, snapshots:0 };
  const stmtStation = db.prepare(`
    INSERT INTO stations (station_id, source, name, lat, lon, type, first_seen, last_seen)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(station_id) DO UPDATE SET
      source = excluded.source,
      name   = excluded.name,
      lat    = excluded.lat,
      lon    = excluded.lon,
      type   = excluded.type,
      last_seen = excluded.last_seen
  `);
  const stmtSnap = db.prepare(`
    INSERT OR IGNORE INTO station_snapshots
      (station_id, ts, pm25, pm10, pm1, aqi, temperature, humidity, station_till)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `);

  const stationBatch = [];
  const snapBatch = [];
  for (const s of live.stations) {
    if (!s?.id || !Number.isFinite(+s.lat) || !Number.isFinite(+s.lon)) continue;
    // Skip scraped IQAir stations (iqs-*): the iqair-scrape worker already keeps
    // their full hourly/daily/monthly history in the iq_scrape_* tables.
    // Re-snapshotting them here duplicates them into stations/station_snapshots,
    // which /api/live + /history would otherwise have to filter out as stale
    // duplicate pins. Skipping at the source keeps those tables clean.
    if (String(s.id).startsWith('iqs-')) continue;
    // Skip OFFLINE tombstone pins (off:true — Smart Citizen retention): they
    // carry no current reading (pm25 null, lastSeen = last archived day).
    // Without this, a freshly-dead unit would get null-pm25 snapshots for the
    // first 48 h until the frozen-sensor guard below kicks in. Skip the
    // catalog upsert too — it would overwrite last_seen with the tombstone's
    // resurfacing time rather than real data time.
    if (s.off) continue;
    stationBatch.push(stmtStation.bind(
      s.id, s.source || 'Unknown', s.name || s.id,
      +s.lat, +s.lon, s.type || null, nowSec
    ));
    // Frozen-sensor guard: if the upstream reading time (station_till) is more
    // than 48 h behind now, the sensor is stuck echoing a stale value — record
    // the catalog row but NOT a snapshot, so we don't archive the frozen echo.
    const tillMs = parseTillMs(s.lastSeen);
    if (tillMs != null && (nowSec * 1000 - tillMs) > STALE_RECORD_MS) continue;
    snapBatch.push(stmtSnap.bind(
      s.id, nowSec,
      toNumberOrNull(s.pm25), toNumberOrNull(s.pm10), toNumberOrNull(s.pm1),
      toIntOrNull(s.aqi),
      toNumberOrNull(s.temperature), toNumberOrNull(s.humidity),
      s.lastSeen || null
    ));
  }
  if (stationBatch.length) await db.batch(stationBatch);
  if (snapBatch.length)    await db.batch(snapBatch);
  // stationsSeen excludes off:true tombstones — they're skipped above and
  // would otherwise drift the archive_runs stations_seen ops metric.
  return { stationsSeen: live.stations.filter(s => !(s && s.off)).length, snapshots: snapBatch.length };
}

// Roll up the last 3 days of station_snapshots into station_daily.
// Re-runs every tick are safe (INSERT OR REPLACE keyed on (station_id,date)),
// and 3-day window keeps today/yesterday accurate as late snapshots arrive
// and snapshots cross midnight WITA. Dates are computed in Asia/Makassar
// (UTC+8) to match nafas_daily and the site's display timezone.
//
// Stale-station guard: snapshots where the upstream `station_till` is more
// than 24h older than fetch `ts` (or >1h in the future) are EXCLUDED. This
// keeps frozen-upstream sensors (e.g. AQICN Lumintang's 2025-08-09 readings)
// from polluting today's row with fake means.
async function rollupDaily(db, nowSec) {
  const cutoffSec = nowSec - 3 * 86400;
  try {
    const r = await db.prepare(`
      INSERT OR REPLACE INTO station_daily
        (station_id, date, pm25_mean, pm25_min, pm25_max, aqi_max, sample_n)
      SELECT
        station_id,
        strftime('%Y-%m-%d', datetime(ts, 'unixepoch', '+8 hours')) AS date,
        ROUND(AVG(pm25), 2) AS pm25_mean,
        ROUND(MIN(pm25), 2) AS pm25_min,
        ROUND(MAX(pm25), 2) AS pm25_max,
        MAX(aqi)            AS aqi_max,
        COUNT(*)            AS sample_n
      FROM station_snapshots
      WHERE ts >= ?1
        AND pm25 IS NOT NULL
        AND (
          station_till IS NULL
          OR (ts - unixepoch(station_till)) BETWEEN -3600 AND 86400
        )
      GROUP BY station_id, date
    `).bind(cutoffSec).run();
    return r?.meta?.changes ?? 0;
  } catch (e) {
    console.warn('rollupDaily failed: ' + (e.message || String(e)));
    return 0;
  }
}

async function archiveOnce(env) {
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  const db = env.ARCHIVE_DB;
  if (!db) throw new Error('ARCHIVE_DB binding missing');

  let stationsSeen = 0, snapshots = 0, hourly = 0, daily = 0;
  let universalStations = 0, universalSnaps = 0, universalDailyRows = 0;
  let ok = 1, errMsg = null;
  let watchdogNote = null;

  // ── Universal pass: snapshot every station from /api/live ────────────
  let universalWarning = null;
  try {
    const live = await fetchUnifiedLive(env.LIVE_ORIGIN);
    const u = await snapshotUniversal(db, live, nowSec);
    universalStations = u.stationsSeen;
    universalSnaps = u.snapshots;
    // Roll up the last 3 days of universal snapshots into station_daily,
    // so the /history page can chart non-Nafas stations. Idempotent.
    universalDailyRows = await rollupDaily(db, nowSec);
    // SAFEGUARD #2 — loop detection (till-distinctness based).
    const loopCheck = await detectStaleLoop(db, nowSec);
    if (loopCheck && loopCheck.total >= 10 && loopCheck.distinct_tills <= 2) {
      universalWarning = `loop_suspect: ${loopCheck.total} stations share only ${loopCheck.distinct_tills} distinct station_till value(s) — upstream may be frozen`;
      console.warn(universalWarning);
    }
  } catch (e) {
    // Non-fatal — Nafas-specific path below still runs. Record the failure.
    universalWarning = 'universal_fetch_failed: ' + (e.message || String(e));
    console.warn(universalWarning);
  }

  try {
    const stations = await fetchBaliStations();
    stationsSeen = stations.length;

    // Parallel fetch details
    const detailed = await Promise.all(stations.map(async (loc) => ({
      loc, detail: await fetchDetail(loc.uuid),
    })));

    const hourlyStmt = buildHourlyStmt(db);
    const dailyStmt  = buildDailyStmt(db);

    for (const { loc, detail } of detailed) {
      await upsertStation(db, loc, nowSec);
      if (!detail) continue;

      await insertSnapshot(db, loc.uuid, nowSec, detail);
      snapshots++;

      // Hourly — detail.measurement.hourly[] = 24 entries
      const hourlyRows = detail?.measurement?.hourly || [];
      const hourlyBatch = [];
      for (const h of hourlyRows) {
        if (!h?.from) continue;
        hourlyBatch.push(hourlyStmt.bind(
          loc.uuid, h.from,
          toNumberOrNull(h.pm25), toNumberOrNull(h.pm10), toNumberOrNull(h.pm1),
          toIntOrNull(h.aqi),
          toNumberOrNull(h.temperature), toNumberOrNull(h.humidity), toNumberOrNull(h.pressure)
        ));
      }
      if (hourlyBatch.length) {
        await db.batch(hourlyBatch);
        hourly += hourlyBatch.length;
      }

      // Daily — detail.measurement.daily[] = ~30 entries
      const dailyRows = detail?.measurement?.daily || [];
      const dailyBatch = [];
      for (const dRow of dailyRows) {
        const date = dateOnly(dRow.from || dRow.date);
        if (!date) continue;
        dailyBatch.push(dailyStmt.bind(
          loc.uuid, date,
          toNumberOrNull(dRow.pm25), toNumberOrNull(dRow.pm10), toNumberOrNull(dRow.pm1),
          toIntOrNull(dRow.aqi),
          toNumberOrNull(dRow.temperature), toNumberOrNull(dRow.humidity), toNumberOrNull(dRow.pressure)
        ));
      }
      if (dailyBatch.length) {
        await db.batch(dailyBatch);
        daily += dailyBatch.length;
      }
    }
  } catch (e) {
    ok = 0;
    errMsg = e.message || String(e);
  }

  // ── IQAir-scrape watchdog ─────────────────────────────────────────────
  // The iqair-scrape worker's SCHEDULED invocations get killed platform-side
  // ("Exceeded CPU Limit" before writing anything) while its HTTP/binding
  // invocations run fine. This worker's cron is demonstrably reliable, so it
  // doubles as the scheduler-of-last-resort: if the STALEST active IQAir station
  // hasn't been scraped in > 70 min (a healthy cron keeps every station ≤ ~60
  // min; /api/live's FRESH_MS is 2.5 h, so 70–85 min keeps stations "live"),
  // trigger one rotation group on the iqair-scrape worker.
  //
  // ORDER: this runs LAST, AFTER the universal + Nafas archival passes above, so
  // a firing watchdog can never delay or eat the wall-clock budget of the
  // critical data writes. With the binding the call actually reaches the worker
  // and `await` now blocks for as long as that scrape takes (tens of seconds) —
  // which is exactly why it must come after archival, not before it.
  //
  // INVOCATION: via the IQAIR_SCRAPE service binding, NOT a workers.dev fetch.
  // The previous version called fetch('https://iqair-scrape.<sub>.workers.dev/
  // watchdog'), which silently returned HTTP 404 from inside a Worker — a same-
  // account Worker→Worker subrequest over the public hostname is intercepted by
  // the edge and never reaches the target. That broke the safety net: on 2026-
  // 06-14 the cron died ~01:22 UTC and this watchdog fired every 15 min for ~9h,
  // each time getting 404, so nothing recovered. The service binding routes
  // directly through the runtime (reliable, no DNS/edge, stays inside CF's
  // network). The /watchdog route stays secret-gated as defense-in-depth.
  // Healthy periods: never fires, zero extra Firecrawl spend.
  try {
    if (env.IQAIR_SCRAPE) {
      const st = await db.prepare(
        `SELECT MIN(last_scrape_ts) AS stalest FROM iq_scrape_stations WHERE active = 1`
      ).first();
      const ageMin = st && st.stalest ? (nowSec - st.stalest) / 60 : null;
      if (ageMin != null && ageMin > 70) {
        const r = await env.IQAIR_SCRAPE.fetch('https://iqair-scrape.internal/watchdog', {
          method: 'POST',
          headers: { 'X-Watchdog-Key': env.IQAIR_WATCHDOG_KEY || '' },
        });
        watchdogNote = `iqair_watchdog_fired (stalest ${Math.round(ageMin)}m, HTTP ${r.status})`;
        console.warn(watchdogNote);
      }
    }
  } catch (e) {
    watchdogNote = 'iqair_watchdog_error: ' + (e.message || String(e));
  }

  const duration = Date.now() - t0;
  try {
    // archive_runs schema only knows about Nafas counters; encode universal
    // counts into the higher columns via simple addition for visibility.
    // Combine errors: Nafas-specific failure + universal-pass warning.
    const combinedErr = [errMsg, universalWarning, watchdogNote].filter(Boolean).join(' | ') || null;
    await db.prepare(`
      INSERT OR REPLACE INTO archive_runs
        (ts, stations_seen, snapshots_written, hourly_upserts, daily_upserts, duration_ms, ok, error)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(
      nowSec,
      stationsSeen + universalStations,
      snapshots + universalSnaps,
      hourly,
      // daily = Nafas-specific upserts + universal-rollup rows touched this tick
      daily + universalDailyRows,
      duration, ok, combinedErr
    ).run();
  } catch (_) { /* never fail on log write */ }

  return {
    ok: !!ok, ts: nowSec,
    nafasStations: stationsSeen, nafasSnapshots: snapshots,
    universalStations, universalSnapshots: universalSnaps,
    universalDailyRows,
    hourly, daily, duration, error: errMsg
  };
}

export default {
  // Scheduled cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(archiveOnce(env));
  },

  // Manual trigger — hit /run with X-Secret header matching env.CRON_SECRET
  // Useful for: first-run backfill, post-deploy sanity check, debugging.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const secret = request.headers.get('X-Secret') || url.searchParams.get('k');
      if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const result = await archiveOnce(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  },
};
