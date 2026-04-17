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

async function archiveOnce(env) {
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  const db = env.ARCHIVE_DB;
  if (!db) throw new Error('ARCHIVE_DB binding missing');

  let stationsSeen = 0, snapshots = 0, hourly = 0, daily = 0;
  let ok = 1, errMsg = null;

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
    await db.prepare(`
      INSERT OR REPLACE INTO archive_runs
        (ts, stations_seen, snapshots_written, hourly_upserts, daily_upserts, duration_ms, ok, error)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(nowSec, stationsSeen, snapshots, hourly, daily, duration, ok, errMsg).run();
  } catch (_) { /* never fail on log write */ }

  return { ok: !!ok, ts: nowSec, stationsSeen, snapshots, hourly, daily, duration, error: errMsg };
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
