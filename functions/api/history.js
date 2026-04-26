// Cloudflare Pages Function — read historical data from D1.
//
// Endpoints:
//   /api/history                                → catalog of all archived stations
//                                                 (Nafas + universal stations)
//   /api/history?uuid=<uuid>&range=…            → Nafas-specific (legacy)
//                                                 ranges: 24h | hourly | daily
//   /api/history?id=<station_id>&range=…        → universal (any source)
//                                                 ranges: 24h | 7d | 30d | 90d | daily | all
//   /api/history?ids=a,b,c&range=daily          → multi-station overlay
//                                                 used by /history page
//
// Binding required on the Pages project:
//   ARCHIVE_DB (D1) — same database the archive worker writes to.

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
function isStationId(s) {
  // station_id format is restrictive — alnum + dash + underscore + dot only
  return typeof s === 'string' && /^[a-zA-Z0-9._-]{2,80}$/.test(s);
}
function rangeToCutoffSec(range) {
  const now = Math.floor(Date.now() / 1000);
  switch (range) {
    case '24h': return now - 24 * 3600;
    case '7d':  return now - 7 * 86400;
    case '30d': return now - 30 * 86400;
    case '90d': return now - 90 * 86400;
    default:    return null;  // "all"
  }
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
  const uuid  = (url.searchParams.get('uuid') || '').trim();
  const id    = (url.searchParams.get('id')   || '').trim();
  const ids   = (url.searchParams.get('ids')  || '').trim();
  const range = (url.searchParams.get('range') || '').trim().toLowerCase();

  try {
    // ── Multi-station mode (?ids=a,b,c) ────────────────────────────────
    if (ids) {
      const list = ids.split(',').map(x => x.trim()).filter(isStationId).slice(0, 12);
      if (!list.length) return json({ error: 'no_valid_ids' }, 400);
      // Try station_daily first (universal). Falls back to nafas_daily
      // for nafas-* ids if station_daily is empty.
      const placeholders = list.map((_,i)=> '?'+(i+1)).join(',');
      const dailyRows = await db.prepare(`
        SELECT station_id, date, pm25_mean AS pm25
        FROM station_daily
        WHERE station_id IN (${placeholders})
        ORDER BY station_id, date ASC
      `).bind(...list).all();
      // Group
      const byId = {};
      for (const r of (dailyRows.results || [])) {
        (byId[r.station_id] ||= []).push({ date: r.date, pm25: r.pm25 });
      }
      // Backfill from nafas_daily for nafas-* ids missing from station_daily
      for (const sid of list) {
        if (byId[sid]?.length) continue;
        if (!sid.startsWith('nafas-')) continue;
        const u = sid.slice(6);
        if (!isUuid(u)) continue;
        const rows = await db.prepare(`
          SELECT date, pm25 FROM nafas_daily WHERE uuid = ?1 ORDER BY date ASC
        `).bind(u).all();
        if (rows.results?.length) {
          byId[sid] = rows.results.map(r => ({ date: r.date, pm25: r.pm25 }));
        }
      }
      return json({ range: range || 'daily', series: byId });
    }

    // ── Universal per-station mode (?id=…) ─────────────────────────────
    if (id) {
      if (!isStationId(id)) return json({ error: 'bad_id' }, 400);
      const stn = await db.prepare(`
        SELECT station_id, source, name, lat, lon, type, first_seen, last_seen
        FROM stations WHERE station_id = ?1
      `).bind(id).first();
      // Time-window snapshots
      if (range === '24h' || range === '7d' || range === '30d' || range === '90d') {
        const cutoff = rangeToCutoffSec(range);
        const rows = await db.prepare(`
          SELECT ts, pm25, pm10, pm1, aqi, temperature, humidity, station_till
          FROM station_snapshots
          WHERE station_id = ?1 AND ts >= ?2
          ORDER BY ts ASC
        `).bind(id, cutoff).all();
        return json({ station: stn, range, points: rows.results || [] });
      }
      // Daily aggregates
      const dRows = await db.prepare(`
        SELECT date, pm25_mean AS pm25, pm25_min, pm25_max, sample_n
        FROM station_daily WHERE station_id = ?1 ORDER BY date ASC
      `).bind(id).all();
      return json({ station: stn, range: range || 'daily', points: dRows.results || [] });
    }

    // ── Legacy Nafas-specific mode (?uuid=…) ───────────────────────────
    if (uuid) {
      if (!isUuid(uuid)) return json({ error: 'bad_uuid' }, 400);
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
          FROM nafas_hourly WHERE uuid = ?1 ORDER BY hour_start ASC
        `).bind(uuid).all();
        return json({ station: stn, range: 'hourly', points: rows.results || [] });
      }
      // daily / 30d (default for legacy mode)
      const rows = await db.prepare(`
        SELECT date, pm25, pm10, pm1, aqi, temperature, humidity, pressure
        FROM nafas_daily WHERE uuid = ?1 ORDER BY date ASC
      `).bind(uuid).all();
      return json({ station: stn, range: range || 'daily', points: rows.results || [] });
    }

    // ── Catalog mode (no params) ───────────────────────────────────────
    // Combine universal stations + Nafas stations into a single list.
    const universal = await db.prepare(`
      SELECT station_id, source, name, lat, lon, type, first_seen, last_seen
      FROM stations ORDER BY name
    `).all();
    const nafas = await db.prepare(`
      SELECT uuid, name, lat, lon, first_seen, last_seen,
             (SELECT pm25 FROM nafas_snapshots WHERE uuid = s.uuid ORDER BY ts DESC LIMIT 1) AS latest_pm25,
             (SELECT ts   FROM nafas_snapshots WHERE uuid = s.uuid ORDER BY ts DESC LIMIT 1) AS latest_ts
      FROM nafas_stations s ORDER BY name
    `).all();
    return json({
      stations: nafas.results || [],          // legacy field — keeps old clients working
      universal: universal.results || [],     // new universal catalog
    });

  } catch (e) {
    return json({ error: 'query_failed', message: e.message }, 500);
  }
}
