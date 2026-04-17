// Cloudflare Pages Function — read historical Nafas data from D1.
//
// Endpoints:
//   /api/history                              → station catalog + latest snapshot per station
//   /api/history?uuid=<uuid>&range=24h        → last 24h of snapshots for one station
//   /api/history?uuid=<uuid>&range=30d        → last 30d of daily aggregates for one station
//   /api/history?uuid=<uuid>&range=hourly     → hourly aggregates (back to whatever we've captured)
//   /api/history?uuid=<uuid>&range=daily      → alias for 30d
//
// Binding required on the Pages project:
//   ARCHIVE_DB (D1) — same database as workers/nafas-archive writes to.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
  ...CORS,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const db = env.ARCHIVE_DB;
  if (!db) {
    return json({ error: 'archive_db_unbound', message: 'D1 binding ARCHIVE_DB missing' }, 503);
  }

  const url = new URL(request.url);
  const uuid = (url.searchParams.get('uuid') || '').trim();
  const range = (url.searchParams.get('range') || '').trim().toLowerCase();

  try {
    // ── Catalog mode: no uuid specified ────────────────────────────────
    if (!uuid) {
      const stations = await db.prepare(`
        SELECT s.uuid, s.name, s.lat, s.lon, s.sponsor, s.vendor, s.first_seen, s.last_seen,
               (SELECT pm25 FROM nafas_snapshots WHERE uuid = s.uuid ORDER BY ts DESC LIMIT 1) AS latest_pm25,
               (SELECT aqi  FROM nafas_snapshots WHERE uuid = s.uuid ORDER BY ts DESC LIMIT 1) AS latest_aqi,
               (SELECT ts   FROM nafas_snapshots WHERE uuid = s.uuid ORDER BY ts DESC LIMIT 1) AS latest_ts
        FROM nafas_stations s
        ORDER BY s.name
      `).all();
      return json({ stations: stations.results || [] });
    }

    // ── Per-station mode ───────────────────────────────────────────────
    if (!isUuid(uuid)) return json({ error: 'bad_uuid' }, 400);

    // Station metadata
    const stn = await db.prepare(`
      SELECT uuid, name, lat, lon, sponsor, vendor, first_seen, last_seen
      FROM nafas_stations WHERE uuid = ?1
    `).bind(uuid).first();
    if (!stn) return json({ error: 'not_found' }, 404);

    if (range === '24h') {
      const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
      const rows = await db.prepare(`
        SELECT ts, station_till, pm25, pm10, pm1, aqi, temperature, humidity, pressure
        FROM nafas_snapshots
        WHERE uuid = ?1 AND ts >= ?2
        ORDER BY ts ASC
      `).bind(uuid, cutoff).all();
      return json({ station: stn, range: '24h', points: rows.results || [] });
    }

    if (range === 'hourly') {
      const rows = await db.prepare(`
        SELECT hour_start, pm25, pm10, pm1, aqi, temperature, humidity, pressure
        FROM nafas_hourly
        WHERE uuid = ?1
        ORDER BY hour_start ASC
      `).bind(uuid).all();
      return json({ station: stn, range: 'hourly', points: rows.results || [] });
    }

    // 30d or daily (default)
    const rows = await db.prepare(`
      SELECT date, pm25, pm10, pm1, aqi, temperature, humidity, pressure
      FROM nafas_daily
      WHERE uuid = ?1
      ORDER BY date ASC
    `).bind(uuid).all();
    return json({ station: stn, range: range || 'daily', points: rows.results || [] });

  } catch (e) {
    return json({ error: 'query_failed', message: e.message }, 500);
  }
}
