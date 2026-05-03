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
  const url = (originBase || 'https://baliair.pages.dev').replace(/\/$/,'') + '/api/live?fresh=1';
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

// SAFEGUARD #2: after writing new snapshots, count how many stations have
// pm25 identical to their previous snapshot. > 80 % unchanged is a strong
// signal that we're in a stale-loop. Returns null on error so the caller
// can degrade gracefully.
async function detectStaleLoop(db, currentTs) {
  try {
    const r = await db.prepare(`
      SELECT COUNT(*) AS unchanged, COUNT(DISTINCT current.station_id) AS total
      FROM station_snapshots AS current
      JOIN (
        SELECT station_id, pm25 AS prev_pm25, MAX(ts) AS prev_ts
        FROM station_snapshots
        WHERE ts < ?1
        GROUP BY station_id
      ) AS prev ON prev.station_id = current.station_id
      WHERE current.ts = ?1
        AND current.pm25 = prev.prev_pm25
        AND current.pm25 IS NOT NULL
    `).bind(currentTs).first();
    return r;  // {unchanged, total}
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
    stationBatch.push(stmtStation.bind(
      s.id, s.source || 'Unknown', s.name || s.id,
      +s.lat, +s.lon, s.type || null, nowSec
    ));
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
  return { stationsSeen: live.stations.length, snapshots: snapBatch.length };
}

async function archiveOnce(env) {
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  const db = env.ARCHIVE_DB;
  if (!db) throw new Error('ARCHIVE_DB binding missing');

  let stationsSeen = 0, snapshots = 0, hourly = 0, daily = 0;
  let universalStations = 0, universalSnaps = 0;
  let ok = 1, errMsg = null;

  // ── Universal pass: snapshot every station from /api/live ────────────
  let universalWarning = null;
  try {
    const live = await fetchUnifiedLive(env.LIVE_ORIGIN);
    const u = await snapshotUniversal(db, live, nowSec);
    universalStations = u.stationsSeen;
    universalSnaps = u.snapshots;
    // SAFEGUARD #2 — loop detection.
    const loopCheck = await detectStaleLoop(db, nowSec);
    if (loopCheck && loopCheck.total >= 5) {
      const ratio = loopCheck.unchanged / loopCheck.total;
      if (ratio > 0.8) {
        universalWarning = `loop_suspect: ${loopCheck.unchanged}/${loopCheck.total} stations had unchanged pm25`;
        console.warn(universalWarning);
      }
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

  const duration = Date.now() - t0;
  try {
    // archive_runs schema only knows about Nafas counters; encode universal
    // counts into the higher columns via simple addition for visibility.
    // Combine errors: Nafas-specific failure + universal-pass warning.
    const combinedErr = [errMsg, universalWarning].filter(Boolean).join(' | ') || null;
    await db.prepare(`
      INSERT OR REPLACE INTO archive_runs
        (ts, stations_seen, snapshots_written, hourly_upserts, daily_upserts, duration_ms, ok, error)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(
      nowSec,
      stationsSeen + universalStations,
      snapshots + universalSnaps,
      hourly, daily, duration, ok, combinedErr
    ).run();
  } catch (_) { /* never fail on log write */ }

  return {
    ok: !!ok, ts: nowSec,
    nafasStations: stationsSeen, nafasSnapshots: snapshots,
    universalStations, universalSnapshots: universalSnaps,
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
