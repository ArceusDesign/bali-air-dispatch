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
  // station_id charset: alnum + dash + underscore + dot + SPACE. The space is
  // required because IQAir station ids are derived from city names
  // (e.g. "iq-Seminyak town", "iq-Dajan Tangluk"); rejecting spaces returned
  // bad_id and blanked those sensors' history charts even though they update
  // every cron tick. Safe: id is only ever used in parameterized D1 queries
  // (.bind(id)), never string-interpolated into SQL.
  return typeof s === 'string' && /^[a-zA-Z0-9._ -]{2,80}$/.test(s);
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

    // ── Scraped IQAir per-station mode (?id=iqs-<slug>) ────────────────
    // These live in the iq_scrape_* tables (written by the iqair-scrape
    // worker), not the universal stations/* tables. Hourly points carry an ISO
    // `ts`; daily/monthly carry ISO `date`/`month`. Daily & monthly are PERIOD
    // AVERAGES (averaged:true → the page shows the "period averages up to
    // today" note). All queries parameterized; id is charset-validated.
    if (id && id.startsWith('iqs-')) {
      if (!isStationId(id)) return json({ error: 'bad_id' }, 400);
      const slug = id.slice(4);
      const srow = await db.prepare(`
        SELECT slug, name, lat, lon, first_seen, latest_ts
        FROM iq_scrape_stations WHERE slug = ?1
      `).bind(slug).first();
      const station = srow ? {
        station_id: id, source: 'IQAir', name: srow.name,
        lat: srow.lat, lon: srow.lon, type: 'Private sensor',
        first_seen: srow.first_seen, last_seen: srow.latest_ts,
      } : null;

      // 24h → raw hourly readings (NOT averaged)
      if (range === '24h') {
        const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
        const rows = await db.prepare(`
          SELECT ts, pm25, aqi FROM iq_scrape_hourly WHERE slug = ?1 ORDER BY ts ASC
        `).bind(slug).all();
        const points = (rows.results || []).filter(r => {
          const ms = Date.parse(r.ts); return Number.isFinite(ms) && ms / 1000 >= cutoff;
        });
        return json({ station, range, points });
      }
      // 1y / monthly → monthly averages
      if (range === '1y' || range === 'monthly' || range === '365d') {
        const rows = await db.prepare(`
          SELECT month AS date, pm25, aqi FROM iq_scrape_monthly WHERE slug = ?1 ORDER BY month ASC
        `).bind(slug).all();
        return json({ station, range, points: rows.results || [], averaged: true });
      }
      // 7d / 30d / 90d / daily / all → daily averages (cutoff-filtered)
      const cutoff = rangeToCutoffSec(range);
      const rows = await db.prepare(`
        SELECT date, pm25, aqi FROM iq_scrape_daily WHERE slug = ?1 ORDER BY date ASC
      `).bind(slug).all();
      let points = rows.results || [];
      if (cutoff != null) {
        points = points.filter(r => {
          const ms = Date.parse(r.date); return Number.isFinite(ms) && ms / 1000 >= cutoff;
        });
      }
      return json({ station, range: range || 'daily', points, averaged: true });
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
      // Daily aggregates — try station_daily first
      const dRows = await db.prepare(`
        SELECT date, pm25_mean AS pm25, pm25_min, pm25_max, sample_n
        FROM station_daily WHERE station_id = ?1 ORDER BY date ASC
      `).bind(id).all();
      let points = dRows.results || [];

      // Fallback: for nafas-* ids whose station_daily is empty, surface the
      // richer Nafas-specific daily aggregates from nafas_daily (which the
      // worker mirrors from Nafas's own daily endpoint).
      if (points.length === 0 && id.startsWith('nafas-')) {
        const u = id.slice(6);
        if (isUuid(u)) {
          const r = await db.prepare(`
            SELECT date, pm25, pm10, pm1, aqi, temperature, humidity, pressure
            FROM nafas_daily WHERE uuid = ?1 ORDER BY date ASC
          `).bind(u).all();
          points = (r.results || []).map(p => ({
            date: p.date, pm25: p.pm25,
            pm25_min: p.pm25, pm25_max: p.pm25, sample_n: 1,
          }));
        }
      }
      return json({ station: stn, range: range || 'daily', points });
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
    // `daily_n` tells the /history UI whether a chart can be drawn yet
    // (0 = snapshots being captured but no daily rollup yet → "archive starting").
    // Hidden from the catalog (display only — their D1 rows are intentionally
    // KEPT, just not surfaced). These IQAir nearest_city nodes were retired in
    // the May 2026 audit: 5 were "satellite-derived model" estimates rather
    // than ground sensors, and iq-Jimbaran duplicated PurpleAir's "Jimbaran by
    // Lumi Clinic". Only the real iq-Ubud (Kopernik) IQAir node is retained.
    const HIDDEN_STATION_IDS = [
      'iq-Seminyak town', 'iq-Dajan Tangluk', 'iq-Banjar',
      'iq-Subagan', 'iq-Munduk', 'iq-Jimbaran',
    ];
    const hidePlaceholders = HIDDEN_STATION_IDS.map((_, i) => '?' + (i + 1)).join(',');
    const universal = await db.prepare(`
      SELECT
        s.station_id, s.source, s.name, s.lat, s.lon, s.type,
        s.first_seen, s.last_seen,
        (SELECT COUNT(*) FROM station_daily WHERE station_id = s.station_id) AS daily_n
      FROM stations s
      WHERE s.station_id NOT IN (${hidePlaceholders})
      -- Scraped IQAir stations (iqs-*) are listed from iq_scrape_* via
      -- scrapedCatalog below; the archive worker also leaks them into the
      -- stations table through /api/live, so exclude here (no double entry).
      AND s.station_id NOT LIKE 'iqs-%'
      ORDER BY s.name
    `).bind(...HIDDEN_STATION_IDS).all();
    const nafas = await db.prepare(`
      SELECT uuid, name, lat, lon, first_seen, last_seen,
             (SELECT pm25 FROM nafas_snapshots WHERE uuid = s.uuid ORDER BY ts DESC LIMIT 1) AS latest_pm25,
             (SELECT ts   FROM nafas_snapshots WHERE uuid = s.uuid ORDER BY ts DESC LIMIT 1) AS latest_ts,
             (SELECT COUNT(*) FROM nafas_daily   WHERE uuid = s.uuid)                       AS daily_n
      FROM nafas_stations s ORDER BY name
    `).all();

    // Scraped IQAir stations (iq_scrape_* tables). Shaped to match the universal
    // catalog rows so /history lists them alongside everything else; daily_n>0
    // signals the chart can render. station_id uses the 'iqs-' prefix the
    // per-id branch above understands.
    let scrapedCatalog = { results: [] };
    try {
      scrapedCatalog = await db.prepare(`
        SELECT 'iqs-' || slug AS station_id, 'IQAir' AS source, name, lat, lon,
               'Private sensor' AS type, first_seen, latest_ts AS last_seen,
               (SELECT COUNT(*) FROM iq_scrape_daily WHERE slug = s.slug) AS daily_n
        FROM iq_scrape_stations s
        WHERE active = 1
        ORDER BY name
      `).all();
    } catch (_) { /* iq_scrape_* may be absent in some envs; skip gracefully */ }

    return json({
      stations: nafas.results || [],          // legacy field — keeps old clients working
      universal: [
        ...(universal.results || []),
        ...(scrapedCatalog.results || []),    // scraped IQAir stations
      ],
    });

  } catch (e) {
    return json({ error: 'query_failed', message: e.message }, 500);
  }
}
