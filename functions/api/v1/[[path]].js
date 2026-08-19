// ─────────────────────────────────────────────────────────────────────────────
// Bali Air Dispatch — public read-only API, v1
//
// A stable, documented, key-free interface onto the whole archive, so
// researchers and citizen hobbyists can pull the data without scraping the
// site. Every route is GET-only, CORS-open, edge-cached, and reads D1 through
// bound parameters exclusively.
//
//   GET /api/v1                 index: version, routes, licence, limits
//   GET /api/v1/stations        catalog of every station, with provenance flags
//   GET /api/v1/latest          most recent reading held for every station
//   GET /api/v1/measurements    the time series (raw | hourly | daily)
//
// Design notes:
//  • The archive is split across three storage families for historical reasons
//    (universal snapshots, the legacy Nafas tables, the scraped-IQAir tables).
//    This module hides that: callers name a station and an interval, and get
//    one consistent row shape back. `source_table` on each response says which
//    family answered, so a result is always traceable.
//  • Keyset pagination (not OFFSET) — a cursor is the last row's sort key, so
//    deep paging costs the same as the first page and can't skip or repeat
//    rows when new data lands mid-pull.
//  • Hard row caps + edge caching keep a bulk download from turning into a D1
//    bill. The whole archive is ~140k rows, so a patient client can have all
//    of it; an impatient one still can't hurt us.
//  • CSV is a first-class format because that is what people actually load
//    into pandas, R and Excel.
// ─────────────────────────────────────────────────────────────────────────────

const VERSION = '1.0.0';
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

// Suspected-indoor monitors. Their readings measure a room, not ambient air, so
// the site excludes them from every island-wide statistic. Exposed here as a
// flag rather than hidden, so researchers can make their own call — but they
// MUST be filterable, which is the whole point of publishing it.
// Kept in sync by hand with INDOOR_IDS in public/index.html + public/history.html.
const INDOOR_IDS = new Set([
  'nafas-ba19b143-3580-4a60-a3ce-135a5e5936dd',  // Pemogan (Nafas)
  'pa-36601',                                     // Jimbaran by Lumi Clinic (PurpleAir)
  // Tonja (nafas-2ab21828-...) was flagged here 27 Jul - 20 Aug 2026 while it
  // read a flat 0.0; it resumed normal ambient values on 3 Aug and the flag was
  // removed. Its run of zeros remains in the archive as recorded.
  // Same physical sensor as pa-36601, republished by IQAir — identical
  // coordinates to 6dp. Flagging only one copy lets an indoor series back into
  // an ambient analysis through the other.
  'iqs-jimbaran-s',                               // Jimbaran (IQAir mirror of pa-36601)
]);

// Networks whose PM2.5 we humidity-correct before publishing (US-EPA 2021).
// See /appendix#methodology. `pm25_raw` carries the uncorrected figure.
const CORRECTED_SOURCES = new Set(['AirGradient', 'PurpleAir']);

// Placeholder/duplicate catalog rows the site does not publish. Mirrors
// HIDDEN_STATION_IDS in functions/api/history.js so the API and the site agree
// on what counts as a station.
const HIDDEN_STATION_IDS = [
  'iq-Seminyak town', 'iq-Dajan Tangluk', 'iq-Banjar',
  'iq-Subagan', 'iq-Munduk', 'iq-Jimbaran',
  'ag-77247',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  // Without this, fetch() in a browser cannot read the paging headers at all,
  // so a JS client silently stops after page one believing it has everything.
  'Access-Control-Expose-Headers': 'X-Next-Cursor, X-Row-Count',
};

const LICENCE = {
  archive:
    'Aggregated archive published for public-interest research. Free to use, ' +
    'redistribute and build on, with attribution.',
  attribution:
    'Attribute both this archive (Bali Air Dispatch, baliair.pages.dev) and the ' +
    'originating network named in each row\'s `source` field.',
  upstream:
    'Readings originate from independent networks (Nafas, IQAir, PurpleAir, ' +
    'AQICN, OpenAQ, AirGradient, Smart Citizen, Airly) and remain subject to ' +
    'their own terms. This project aggregates and preserves; it does not own ' +
    'the underlying measurements.',
  no_warranty:
    'Low-cost sensors are not reference-grade instruments. Values are provided ' +
    'as recorded, without warranty of accuracy or fitness for any purpose.',
};

function json(body, { status = 200, maxAge = 300 } = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, s-maxage=${maxAge}, max-age=60, stale-while-revalidate=86400`,
      ...CORS,
    },
  });
}

function fail(code, message, status = 400, extra = {}) {
  const res = json({ error: code, message, ...extra }, { status, maxAge: 0 });
  // json() emits a public/stale-while-revalidate policy; an error must not
  // inherit it or one transient 503 gets served for 24 h from cache.
  res.headers.set('Cache-Control', 'no-store');
  if (status === 405) res.headers.set('Allow', 'GET, HEAD, OPTIONS');
  return res;
}

// CSV cell with two separate concerns handled:
//  1. RFC4180 quoting for commas / quotes / newlines.
//  2. Spreadsheet formula injection — a station name arrives from an external
//     feed and anyone can name a device `=HYPERLINK(...)`. Excel/Sheets execute
//     a leading = + - @ (or tab/CR), so prefix those with an apostrophe. Data
//     integrity over prettiness: the value is still legible, just inert.
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvResponse(rows, columns, filename, maxAge = 300) {
  const head = columns.join(',');
  const body = rows.map(r => columns.map(c => csvCell(r[c])).join(',')).join('\n');
  return new Response(head + '\n' + body + (rows.length ? '\n' : ''), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': `public, s-maxage=${maxAge}, max-age=60, stale-while-revalidate=86400`,
      ...CORS,
    },
  });
}

// Station ids come from upstream networks and are used as D1 bind values and
// cursor components. Charset mirrors functions/api/history.js — alphanumerics,
// dash, underscore, dot and SPACE (IQAir city ids contain spaces). Never
// interpolated into SQL regardless; this is defence in depth plus a clean 400.
function isStationId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 80 &&
         /^[A-Za-z0-9._\- ]+$/.test(s);
}

// Accepts YYYY-MM-DD, a full ISO-8601 instant, or unix seconds. Returns unix
// seconds, or null if unparseable. Bare dates are read as UTC midnight.
function parseWhen(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{9,11}$/.test(s)) {                       // unix seconds
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(s + 'T00:00:00Z');
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const isoFromUnix = (sec) => new Date(sec * 1000).toISOString();
const dayFromUnix = (sec) => isoFromUnix(sec).slice(0, 10);

function clampLimit(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// Cursors are opaque to callers but are just the last row's sort key. Bulk
// queries sort by (station_id, key) so the cursor carries both.
// The separator MUST be a character no station_id can contain. Ids are
// [A-Za-z0-9._- ] and several real ones contain a SPACE ("iq-Dajan Tangluk"),
// so a space separator would split such an id in half and silently corrupt
// bulk paging — skipping or repeating rows. '|' is outside the id charset.
const CURSOR_SEP = '|';
function encodeCursor(parts) {
  return encodeURIComponent(parts.map(p => String(p ?? '')).join(CURSOR_SEP));
}
function decodeCursor(raw) {
  if (!raw) return null;
  // URLSearchParams has already percent-decoded once; decoding again is a
  // no-op for a well-formed cursor but rescues a client that re-encoded the
  // token it was handed. Malformed input yields null → start from page one.
  let s = String(raw);
  try { s = decodeURIComponent(s); } catch { /* use as-is */ }
  const parts = s.split(CURSOR_SEP);
  return parts.length ? parts : null;
}

// A cursor must carry exactly the number of key components the query sorts on
// (1 for a single station, 2 for a bulk scan). A hand-edited or truncated
// token would otherwise bind `undefined` into D1 and surface as a 500; this
// turns it into an actionable 400. Returns an error string, or null if valid.
function cursorProblem(cursor, expectedParts) {
  if (!cursor) return null;
  if (cursor.length !== expectedParts) {
    return `cursor must have ${expectedParts} component(s); pass back the ` +
           '`next_cursor` value from the previous response unmodified';
  }
  if (cursor.some(p => p == null || p === '')) return 'cursor has an empty component';
  if (expectedParts === 2 && !isStationId(cursor[0])) return 'cursor station component is not a valid station_id';
  return null;
}

// Which storage family answers for a station id, per interval.
//   iqs-*    scraped IQAir pages      → iq_scrape_hourly / iq_scrape_daily
//   nafas-*  legacy Nafas tables      → nafas_hourly / nafas_daily (+ snapshots)
//   *        universal snapshot store → station_snapshots / station_daily
function familyFor(id) {
  if (id.startsWith('iqs-')) return 'iqair_scrape';
  if (id.startsWith('nafas-')) return 'nafas';
  return 'universal';
}

// ── /api/v1 ──────────────────────────────────────────────────────────────────
function routeIndex(origin) {
  return json({
    name: 'Bali Air Dispatch API',
    version: VERSION,
    description:
      'Read-only access to an aggregated archive of Bali air-quality ' +
      'measurements (PM2.5 and companion values) collected from public sensor ' +
      'networks since 2025. No key, no account, no rate limit beyond fair use.',
    endpoints: {
      stations: {
        path: '/api/v1/stations',
        description: 'Every station in the archive, with coordinates, source network and provenance flags.',
        params: { source: 'filter by network', format: 'json|csv' },
      },
      latest: {
        path: '/api/v1/latest',
        description: 'The most recent reading held for every station.',
        params: { source: 'filter by network', format: 'json|csv' },
      },
      measurements: {
        path: '/api/v1/measurements',
        description: 'Time series. Omit `station` to pull every station (paginate with `cursor`).',
        params: {
          station: 'station_id from /stations (optional — omit for all stations)',
          interval: 'raw | hourly | daily   (default: daily)',
          from: 'YYYY-MM-DD, ISO-8601 instant, or unix seconds',
          to: 'YYYY-MM-DD, ISO-8601 instant, or unix seconds',
          limit: `rows per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
          cursor: 'continuation token from the previous response',
          format: 'json|csv',
        },
      },
    },
    intervals: {
      raw: '15-minute snapshots as fetched. Not available for iqs-* (IQAir publishes hourly).',
      hourly: 'Hourly means. Native for nafas-* and iqs-*; bucketed from raw snapshots otherwise.',
      daily: 'Daily means, with min/max/sample count where available.',
    },
    notes: {
      timezone:
        'Instants (observed_at, first_seen, last_seen) are UTC, ISO-8601 with a ' +
        'Z. Bali local time is WITA = UTC+8. NOTE: daily `date` values are WITA ' +
        'calendar days, not UTC days — the archive aggregates on the local day, ' +
        'which is the meaningful one for a Bali reader. Each /measurements ' +
        'response states which basis applies in `date_basis`.',
      samples:
        'On aggregate rows, `samples` is how many observations went into the ' +
        'mean. Older daily rows can carry samples=1 (a single observation ' +
        'backfilled, with min = max = mean); treat a low sample count as a ' +
        'weak daily average and prefer interval=raw or hourly where precision ' +
        'matters.',
      units: 'PM2.5, PM10, PM1 in µg/m³. Temperature °C. Humidity %.',
      corrected:
        'AirGradient and PurpleAir readings are humidity-corrected (US-EPA 2021) ' +
        'before publication; `pm25_raw` carries the uncorrected sensor figure. ' +
        'All other networks are as-supplied. See /appendix#methodology.',
      suspected_indoor:
        'Stations flagged `suspected_indoor` measure a room, not ambient air. ' +
        'They are published for completeness and excluded from every island-wide ' +
        'statistic on the site. Filter them out for ambient analysis.',
      gaps:
        'Gaps are real. A sensor that went silent has no rows for that period ' +
        'rather than carried-forward values.',
      staleness:
        '/latest returns the newest reading HELD for each station, which for a ' +
        'sensor that has gone dark may be weeks old. Check `age_hours` and the ' +
        '`stale` flag (true when older than 24 h) before treating a row as ' +
        'current conditions.',
    },
    licence: LICENCE,
    documentation: `${origin}/api`,
  }, { maxAge: 3600 });
}

// ── /api/v1/stations ─────────────────────────────────────────────────────────
async function routeStations(db, url) {
  const wantSource = (url.searchParams.get('source') || '').trim().toLowerCase();
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const hidden = HIDDEN_STATION_IDS;
  const holes = hidden.map((_, i) => '?' + (i + 1)).join(',');

  const universal = await db.prepare(`
    SELECT s.station_id, s.source, s.name, s.lat, s.lon, s.type,
           s.first_seen, s.last_seen,
           (SELECT COUNT(*) FROM station_daily WHERE station_id = s.station_id) AS daily_n,
           (SELECT MIN(date) FROM station_daily WHERE station_id = s.station_id) AS first_date,
           (SELECT MAX(date) FROM station_daily WHERE station_id = s.station_id) AS last_date
    FROM stations s
    WHERE s.station_id NOT IN (${holes})
      AND s.station_id NOT LIKE 'iqs-%'
    ORDER BY s.name
  `).bind(...hidden).all();

  const scraped = await db.prepare(`
    SELECT 'iqs-' || slug AS station_id, 'IQAir' AS source, name, lat, lon,
           COALESCE(source_type, 'Scraped station') AS type,
           first_seen, last_scrape_ts AS last_seen,
           (SELECT COUNT(*) FROM iq_scrape_daily WHERE slug = s.slug) AS daily_n,
           (SELECT MIN(date) FROM iq_scrape_daily WHERE slug = s.slug) AS first_date,
           (SELECT MAX(date) FROM iq_scrape_daily WHERE slug = s.slug) AS last_date
    FROM iq_scrape_stations s
    WHERE active = 1
    ORDER BY name
  `).all();

  const shape = (r) => ({
    station_id: r.station_id,
    name: r.name,
    source: r.source,
    latitude: r.lat != null ? +r.lat : null,
    longitude: r.lon != null ? +r.lon : null,
    type: r.type || null,
    first_seen: r.first_seen ? isoFromUnix(+r.first_seen) : null,
    last_seen: r.last_seen ? isoFromUnix(+r.last_seen) : null,
    first_date: r.first_date ? String(r.first_date).slice(0, 10) : null,
    last_date: r.last_date ? String(r.last_date).slice(0, 10) : null,
    days_of_data: +r.daily_n || 0,
    suspected_indoor: INDOOR_IDS.has(r.station_id),
    // Network POLICY, not a per-row claim: rows archived before 2026-07-21
    // are uncorrected even for these networks. Per-row truth is pm25_raw
    // being present on a /measurements or /latest row.
    pm25_correction_applied_since: CORRECTED_SOURCES.has(r.source) ? '2026-07-21' : null,
    interval_source: familyFor(r.station_id),
  });

  let rows = [...(universal.results || []), ...(scraped.results || [])].map(shape);
  if (wantSource) rows = rows.filter(r => (r.source || '').toLowerCase() === wantSource);
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (format === 'csv') {
    return csvResponse(rows, [
      'station_id', 'name', 'source', 'latitude', 'longitude', 'type',
      'first_date', 'last_date', 'days_of_data', 'suspected_indoor',
      // Must track the property name emitted by shape() above — when this said
      // 'pm25_corrected' after the field was renamed, the CSV carried a header
      // that was blank on every row, which reads as "false" to anyone loading it.
      'pm25_correction_applied_since', 'interval_source',
    ], 'baliair-stations.csv', 900);
  }
  return json({ version: VERSION, count: rows.length, licence: LICENCE, stations: rows }, { maxAge: 900 });
}

// ── /api/v1/latest ───────────────────────────────────────────────────────────
async function routeLatest(db, url) {
  const wantSource = (url.searchParams.get('source') || '').trim().toLowerCase();
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const hidden = HIDDEN_STATION_IDS;
  const holes = hidden.map((_, i) => '?' + (i + 1)).join(',');

  // The obvious form of this query — `WHERE sn.ts = (SELECT MAX(ts) ... WHERE
  // station_id = s.station_id)` — runs a correlated scalar subquery per row and
  // measured 359,415 rows read on production for a 47-row answer. Grouping once
  // and joining back reads the index a single time instead.
  // MATERIALIZED is load-bearing, not decoration. Without it SQLite flattens the
  // CTE, decides to drive from station_snapshots and scans the whole table:
  // measured 359,415 rows read for a 47-row answer. Materialised, it drives from
  // the ~50-row catalog and does one index seek per station — 194 rows read, a
  // 1,850x reduction. This endpoint is key-free and public, so that difference
  // is the difference between a cheap API and one anonymous loop away from
  // exhausting the daily D1 read budget.
  const universal = await db.prepare(`
    WITH newest AS MATERIALIZED (
      SELECT s2.station_id AS sid,
             (SELECT x.ts FROM station_snapshots x
               WHERE x.station_id = s2.station_id ORDER BY x.ts DESC LIMIT 1) AS mts
      FROM stations s2
    )
    SELECT s.station_id, s.source, s.name, s.lat, s.lon,
           sn.ts, sn.pm25, sn.pm25_raw, sn.pm10, sn.pm1, sn.aqi,
           sn.temperature, sn.humidity, sn.station_till
    FROM newest n
    JOIN station_snapshots sn ON sn.station_id = n.sid AND sn.ts = n.mts
    JOIN stations s ON s.station_id = n.sid
    WHERE s.station_id NOT IN (${holes})
      AND s.station_id NOT LIKE 'iqs-%'
  `).bind(...hidden).all();

  const scraped = await db.prepare(`
    SELECT 'iqs-' || slug AS station_id, 'IQAir' AS source, name, lat, lon,
           last_scrape_ts AS ts, latest_pm25 AS pm25, latest_aqi AS aqi, latest_ts AS station_till
    FROM iq_scrape_stations WHERE active = 1 AND latest_pm25 IS NOT NULL
  `).all();

  const num = (v) => (v == null ? null : +v);
  // "Latest" means the newest reading HELD, which for a sensor that went dark
  // months ago is a months-old value. Without an explicit signal a caller can
  // reasonably read this endpoint as "conditions now" and average a frozen
  // 168 µg/m³ from two months ago into a live figure. age_hours + stale make
  // that impossible to do by accident; the row is still returned, because
  // knowing a station's last-known value is legitimately useful.
  const nowSec = Math.floor(Date.now() / 1000);
  const STALE_AFTER_H = 24;
  const shape = (r) => ({
    station_id: r.station_id,
    name: r.name,
    source: r.source,
    latitude: r.lat != null ? +r.lat : null,
    longitude: r.lon != null ? +r.lon : null,
    observed_at: r.ts ? isoFromUnix(+r.ts) : null,
    age_hours: r.ts ? +(((nowSec - +r.ts) / 3600).toFixed(1)) : null,
    stale: r.ts ? ((nowSec - +r.ts) / 3600) > STALE_AFTER_H : true,
    upstream_timestamp: r.station_till || null,
    pm25: num(r.pm25),
    pm25_raw: num(r.pm25_raw),
    pm10: num(r.pm10),
    pm1: num(r.pm1),
    aqi: num(r.aqi),
    temperature: num(r.temperature),
    humidity: num(r.humidity),
    suspected_indoor: INDOOR_IDS.has(r.station_id),
    pm25_corrected: r.pm25_raw != null,
  });

  let rows = [...(universal.results || []), ...(scraped.results || [])].map(shape);
  if (wantSource) rows = rows.filter(r => (r.source || '').toLowerCase() === wantSource);
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (format === 'csv') {
    return csvResponse(rows, [
      'station_id', 'name', 'source', 'latitude', 'longitude', 'observed_at',
      'age_hours', 'stale', 'pm25', 'pm25_raw', 'pm10', 'pm1', 'aqi',
      'temperature', 'humidity', 'suspected_indoor', 'pm25_corrected',
    ], 'baliair-latest.csv', 300);
  }
  return json({
    version: VERSION,
    generated_at: new Date().toISOString(),
    count: rows.length,
    licence: LICENCE,
    readings: rows,
  }, { maxAge: 300 });
}

// Hidden placeholder/duplicate ids, as a bind list for any query that scans
// more than one station. Aggregating a bulk pull that still contains ag-77247
// double-counts the long-running Tonja station.
function hiddenClause(next) {
  // next(id) must receive the value — calling next() bare pushes `undefined`
  // into the bind list, which D1 rejects outright ("Type 'undefined' not
  // supported") and surfaces as a 500 on every bulk request.
  return HIDDEN_STATION_IDS.map((id) => next(id)).join(',');
}

// ── /api/v1/measurements ─────────────────────────────────────────────────────
// Every predicate here is emitted ONLY when the caller supplied it. The tempting
// `(?1 IS NULL OR ts >= ?1)` idiom reads well but is a disjunction, so SQLite
// cannot turn it into an index range seek: measured on production, a one-day
// window read 119,810 rows that way against 1,384 rows with a plain `ts >= ?`.
// Same result, 87x the work — and it made a fabricated cursor as expensive as a
// full scan. Hence the little builder below.
async function routeMeasurements(db, url) {
  const station = url.searchParams.get('station');
  const interval = (url.searchParams.get('interval') || 'daily').toLowerCase();
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const limit = clampLimit(url.searchParams.get('limit'));

  if (!['raw', 'hourly', 'daily'].includes(interval)) {
    return fail('bad_interval', 'interval must be one of: raw, hourly, daily');
  }
  if (station != null && !isStationId(station)) {
    return fail('bad_station', 'station must be a station_id from /api/v1/stations');
  }
  const rawFrom = url.searchParams.get('from');
  const rawTo = url.searchParams.get('to');
  const from = parseWhen(rawFrom);
  let to = parseWhen(rawTo);
  if (rawFrom && from == null) return fail('bad_from', 'from must be YYYY-MM-DD, an ISO-8601 instant, or unix seconds');
  if (rawTo && to == null) return fail('bad_to', 'to must be YYYY-MM-DD, an ISO-8601 instant, or unix seconds');
  // A bare `to=YYYY-MM-DD` parses to midnight, which for raw/hourly silently
  // drops that whole day while interval=daily includes it — the same window
  // meaning two different periods. Extend a bare date to end-of-day so every
  // interval agrees that `to` is inclusive of the day named.
  if (to != null && /^\d{4}-\d{2}-\d{2}$/.test(String(rawTo).trim())) to += 86399;
  if (from != null && to != null && to < from) return fail('bad_range', 'to must not be earlier than from');

  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const cursorErr = cursorProblem(cursor, station ? 1 : 2);
  if (cursorErr) return fail('bad_cursor', cursorErr);
  const family = station ? familyFor(station) : null;

  // Bulk hourly has to aggregate before it can page, so LIMIT bounds the
  // response but not the work. Require a bounded window rather than let one
  // anonymous request grind the whole snapshot table.
  const BULK_HOURLY_MAX_DAYS = 31;
  if (!station && interval === 'hourly') {
    if (from == null || to == null) {
      return fail('window_required',
        'interval=hourly across all stations must be bounded: supply from and to ' +
        `(maximum ${BULK_HOURLY_MAX_DAYS} days), or name a single station.`);
    }
    if ((to - from) > BULK_HOURLY_MAX_DAYS * 86400) {
      return fail('window_too_large',
        `interval=hourly across all stations is limited to ${BULK_HOURLY_MAX_DAYS} days per request.`);
    }
  }

  const binds = [];
  const next = (v) => { binds.push(v); return '?' + binds.length; };
  const conds = [];
  const dFrom = from != null ? dayFromUnix(from) : null;
  const dTo = to != null ? dayFromUnix(to) : null;

  let sql, sourceTable, keyIsDate = false;

  if (interval === 'daily') {
    keyIsDate = true;
    if (station && family === 'iqair_scrape') {
      sourceTable = 'iq_scrape_daily';
      const slug = station.slice(4);
      conds.push(`slug = ${next(slug)}`, 'pm25 IS NOT NULL');
      if (dFrom) conds.push(`substr(date,1,10) >= ${next(dFrom)}`);
      if (dTo) conds.push(`substr(date,1,10) <= ${next(dTo)}`);
      if (cursor) conds.push(`substr(date,1,10) > ${next(cursor[0])}`);
      sql = `SELECT ${next(station)} AS station_id, substr(date,1,10) AS key, pm25 AS pm25_mean,
                    NULL AS pm25_min, NULL AS pm25_max, aqi AS aqi_max, n AS sample_n, 'IQAir' AS source
             FROM iq_scrape_daily WHERE ${conds.join(' AND ')}
             ORDER BY date ASC LIMIT ${next(limit)}`;
    } else if (station && family === 'nafas') {
      // ALWAYS nafas_daily for Nafas, never "station_daily and fall back if
      // empty". That fallback was evaluated per request, so the same station
      // returned a different series depending on page size, and one paged pull
      // concatenated two incompatible aggregations. nafas_daily is also simply
      // the deeper record everywhere (e.g. 111 days against 3).
      sourceTable = 'nafas_daily';
      const uuid = station.slice(6);
      conds.push(`uuid = ${next(uuid)}`, 'pm25 IS NOT NULL');
      if (dFrom) conds.push(`date >= ${next(dFrom)}`);
      if (dTo) conds.push(`date <= ${next(dTo)}`);
      if (cursor) conds.push(`date > ${next(cursor[0])}`);
      sql = `SELECT ${next(station)} AS station_id, date AS key, pm25 AS pm25_mean,
                    NULL AS pm25_min, NULL AS pm25_max, aqi AS aqi_max, NULL AS sample_n, 'Nafas' AS source
             FROM nafas_daily WHERE ${conds.join(' AND ')}
             ORDER BY date ASC LIMIT ${next(limit)}`;
    } else if (station) {
      sourceTable = 'station_daily';
      conds.push(`d.station_id = ${next(station)}`);
      if (dFrom) conds.push(`d.date >= ${next(dFrom)}`);
      if (dTo) conds.push(`d.date <= ${next(dTo)}`);
      if (cursor) conds.push(`d.date > ${next(cursor[0])}`);
      sql = `SELECT d.station_id, d.date AS key, d.pm25_mean, d.pm25_min, d.pm25_max,
                    d.aqi_max, d.sample_n, s.source
             FROM station_daily d LEFT JOIN stations s ON s.station_id = d.station_id
             WHERE ${conds.join(' AND ')} ORDER BY d.date ASC LIMIT ${next(limit)}`;
    } else {
      // Bulk: union all three daily stores. Querying station_daily alone made
      // "pull everything" quietly wrong — iqs-bali-umalas-villa-fusion has 562
      // days of its own but contributed a single row, and Nafas stations were
      // represented by the shallow universal rollup instead of their real series.
      sourceTable = 'station_daily + nafas_daily + iq_scrape_daily';
      const inner = `
        SELECT d.station_id, d.date AS key, d.pm25_mean, d.pm25_min, d.pm25_max,
               d.aqi_max, d.sample_n, s.source
          FROM station_daily d LEFT JOIN stations s ON s.station_id = d.station_id
         WHERE d.station_id NOT LIKE 'nafas-%' AND d.station_id NOT LIKE 'iqs-%'
           AND d.station_id NOT IN (${hiddenClause(next)})
        UNION ALL
        SELECT 'nafas-' || uuid, date, pm25, NULL, NULL, aqi, NULL, 'Nafas'
          FROM nafas_daily WHERE pm25 IS NOT NULL
        UNION ALL
        SELECT 'iqs-' || slug, substr(date,1,10), pm25, NULL, NULL, aqi, n, 'IQAir'
          FROM iq_scrape_daily WHERE pm25 IS NOT NULL`;
      if (dFrom) conds.push(`key >= ${next(dFrom)}`);
      if (dTo) conds.push(`key <= ${next(dTo)}`);
      if (cursor) {
        const cs = next(cursor[0]), ck = next(cursor[1]);
        conds.push(`(station_id > ${cs} OR (station_id = ${cs} AND key > ${ck}))`);
      }
      sql = `SELECT * FROM (${inner}) ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
             ORDER BY station_id ASC, key ASC LIMIT ${next(limit)}`;
    }
  } else if (interval === 'hourly') {
    if (station && family === 'iqair_scrape') {
      sourceTable = 'iq_scrape_hourly';
      const slug = station.slice(4);
      conds.push(`slug = ${next(slug)}`, 'pm25 IS NOT NULL');
      if (from != null) conds.push(`unixepoch(ts) >= ${next(from)}`);
      if (to != null) conds.push(`unixepoch(ts) <= ${next(to)}`);
      if (cursor) conds.push(`unixepoch(ts) > ${next(Number(cursor[0]))}`);
      sql = `SELECT ${next(station)} AS station_id, unixepoch(ts) AS key, pm25 AS pm25_mean,
                    NULL AS pm25_min, NULL AS pm25_max, aqi AS aqi_max, NULL AS sample_n, 'IQAir' AS source
             FROM iq_scrape_hourly WHERE ${conds.join(' AND ')} ORDER BY ts ASC LIMIT ${next(limit)}`;
    } else if (station && family === 'nafas') {
      sourceTable = 'nafas_hourly';
      const uuid = station.slice(6);
      conds.push(`uuid = ${next(uuid)}`, 'pm25 IS NOT NULL');
      if (from != null) conds.push(`unixepoch(hour_start) >= ${next(from)}`);
      if (to != null) conds.push(`unixepoch(hour_start) <= ${next(to)}`);
      if (cursor) conds.push(`unixepoch(hour_start) > ${next(Number(cursor[0]))}`);
      sql = `SELECT ${next(station)} AS station_id, unixepoch(hour_start) AS key, pm25 AS pm25_mean,
                    NULL AS pm25_min, NULL AS pm25_max, aqi AS aqi_max, NULL AS sample_n, 'Nafas' AS source
             FROM nafas_hourly WHERE ${conds.join(' AND ')} ORDER BY hour_start ASC LIMIT ${next(limit)}`;
    } else if (station) {
      sourceTable = 'station_snapshots (hourly buckets)';
      conds.push(`sn.station_id = ${next(station)}`, 'sn.pm25 IS NOT NULL');
      if (from != null) conds.push(`sn.ts >= ${next(from)}`);
      if (to != null) conds.push(`sn.ts <= ${next(to)}`);
      if (cursor) conds.push(`sn.ts >= ${next(Number(cursor[0]) + 3600)}`);
      sql = `SELECT sn.station_id, (sn.ts / 3600) * 3600 AS key,
                    ROUND(AVG(sn.pm25), 2) AS pm25_mean, ROUND(MIN(sn.pm25), 2) AS pm25_min,
                    ROUND(MAX(sn.pm25), 2) AS pm25_max, MAX(sn.aqi) AS aqi_max,
                    COUNT(*) AS sample_n, MAX(s.source) AS source
             FROM station_snapshots sn LEFT JOIN stations s ON s.station_id = sn.station_id
             WHERE ${conds.join(' AND ')}
             GROUP BY sn.station_id, key ORDER BY key ASC LIMIT ${next(limit)}`;
    } else {
      sourceTable = 'station_snapshots (hourly buckets) + nafas_hourly + iq_scrape_hourly';
      const c2 = [];
      c2.push(`sn.ts >= ${next(from)}`, `sn.ts <= ${next(to)}`, 'sn.pm25 IS NOT NULL',
              `sn.station_id NOT LIKE 'nafas-%'`, `sn.station_id NOT IN (${hiddenClause(next)})`);
      const uni = `SELECT sn.station_id, (sn.ts / 3600) * 3600 AS key,
                          ROUND(AVG(sn.pm25),2) AS pm25_mean, ROUND(MIN(sn.pm25),2) AS pm25_min,
                          ROUND(MAX(sn.pm25),2) AS pm25_max, MAX(sn.aqi) AS aqi_max,
                          COUNT(*) AS sample_n, MAX(s.source) AS source
                     FROM station_snapshots sn LEFT JOIN stations s ON s.station_id = sn.station_id
                    WHERE ${c2.join(' AND ')} GROUP BY sn.station_id, key`;
      const naf = `SELECT 'nafas-' || uuid, unixepoch(hour_start), pm25, NULL, NULL, aqi, NULL, 'Nafas'
                     FROM nafas_hourly WHERE pm25 IS NOT NULL
                      AND unixepoch(hour_start) >= ${next(from)} AND unixepoch(hour_start) <= ${next(to)}`;
      const iq  = `SELECT 'iqs-' || slug, unixepoch(ts), pm25, NULL, NULL, aqi, NULL, 'IQAir'
                     FROM iq_scrape_hourly WHERE pm25 IS NOT NULL
                      AND unixepoch(ts) >= ${next(from)} AND unixepoch(ts) <= ${next(to)}`;
      if (cursor) {
        const cs = next(cursor[0]), ck = next(Number(cursor[1]));
        conds.push(`(station_id > ${cs} OR (station_id = ${cs} AND key > ${ck}))`);
      }
      sql = `SELECT * FROM (${uni} UNION ALL ${naf} UNION ALL ${iq})
             ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
             ORDER BY station_id ASC, key ASC LIMIT ${next(limit)}`;
    }
  } else { // raw
    if (station && family === 'iqair_scrape') {
      return fail('no_raw_for_source',
        'IQAir publishes hourly, so scraped IQAir stations (iqs-*) have no raw ' +
        'sub-hourly series. Use interval=hourly or interval=daily.', 400,
        { station, available_intervals: ['hourly', 'daily'] });
    }
    sourceTable = 'station_snapshots';
    if (station) conds.push(`sn.station_id = ${next(station)}`);
    else conds.push(`sn.station_id NOT IN (${hiddenClause(next)})`);
    if (from != null) conds.push(`sn.ts >= ${next(from)}`);
    if (to != null) conds.push(`sn.ts <= ${next(to)}`);
    if (cursor) {
      if (station) conds.push(`sn.ts > ${next(Number(cursor[0]))}`);
      else {
        const cs = next(cursor[0]), ck = next(Number(cursor[1]));
        conds.push(`(sn.station_id > ${cs} OR (sn.station_id = ${cs} AND sn.ts > ${ck}))`);
      }
    }
    sql = `SELECT sn.station_id, sn.ts AS key, sn.pm25, sn.pm25_raw, sn.pm10, sn.pm1,
                  sn.aqi, sn.temperature, sn.humidity, sn.station_till, s.source
           FROM station_snapshots sn LEFT JOIN stations s ON s.station_id = sn.station_id
           WHERE ${conds.join(' AND ')}
           ORDER BY ${station ? '' : 'sn.station_id ASC, '}sn.ts ASC LIMIT ${next(limit)}`;
  }

  const rows = (await db.prepare(sql).bind(...binds).all()).results || [];

  const num = (v) => (v == null ? null : +v);
  const shaped = rows.map(r => {
    const base = {
      station_id: r.station_id,
      source: r.source || null,
      suspected_indoor: INDOOR_IDS.has(r.station_id),
    };
    if (keyIsDate) base.date = String(r.key).slice(0, 10);
    else base.observed_at = isoFromUnix(Number(r.key));
    if (interval === 'raw') {
      Object.assign(base, {
        pm25: num(r.pm25), pm25_raw: num(r.pm25_raw),
        // Per-row truth, not a network-wide claim: only rows carrying a raw
        // figure actually had the humidity correction applied.
        pm25_corrected: r.pm25_raw != null,
        pm10: num(r.pm10), pm1: num(r.pm1), aqi: num(r.aqi),
        temperature: num(r.temperature), humidity: num(r.humidity),
        upstream_timestamp: r.station_till || null,
      });
    } else {
      Object.assign(base, {
        pm25: num(r.pm25_mean), pm25_min: num(r.pm25_min), pm25_max: num(r.pm25_max),
        aqi_max: num(r.aqi_max), samples: num(r.sample_n),
      });
    }
    return base;
  });

  const last = rows.length ? rows[rows.length - 1] : null;
  const more = rows.length === limit && last != null;
  const nextCursor = more
    ? (station ? encodeCursor([last.key]) : encodeCursor([last.station_id, last.key]))
    : null;

  if (format === 'csv') {
    const columns = interval === 'raw'
      ? ['station_id', 'source', 'observed_at', 'pm25', 'pm25_raw', 'pm25_corrected', 'pm10', 'pm1', 'aqi', 'temperature', 'humidity', 'suspected_indoor']
      : keyIsDate
        ? ['station_id', 'source', 'date', 'pm25', 'pm25_min', 'pm25_max', 'aqi_max', 'samples', 'suspected_indoor']
        : ['station_id', 'source', 'observed_at', 'pm25', 'pm25_min', 'pm25_max', 'aqi_max', 'samples', 'suspected_indoor'];
    const res = csvResponse(shaped, columns,
      `baliair-${interval}${station ? '-' + station.replace(/[^A-Za-z0-9._-]/g, '_') : ''}.csv`, 600);
    if (nextCursor) res.headers.set('X-Next-Cursor', nextCursor);
    res.headers.set('X-Row-Count', String(shaped.length));
    return res;
  }

  return json({
    version: VERSION,
    query: {
      station: station || null, interval,
      from: from != null ? isoFromUnix(from) : null,
      to: to != null ? isoFromUnix(to) : null,
      limit,
    },
    source_table: sourceTable,
    date_basis: keyIsDate ? 'WITA (UTC+8) calendar day' : 'UTC instant',
    count: shaped.length,
    next_cursor: nextCursor,
    licence: LICENCE,
    measurements: shaped,
  }, { maxAge: 600 });
}

// ── entrypoint ───────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env, params, waitUntil } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail('method_not_allowed', 'This API is read-only. Use GET.', 405);
  }

  // Explicit cache, because Cloudflare Pages Functions responses do NOT pass
  // through the CDN cache: measured in production, three identical requests
  // each re-ran the query and no response ever carried cf-cache-status. The
  // Cache-Control headers were therefore decorative, which left every route
  // one anonymous loop away from hammering D1. caches.default is the real
  // thing and is keyed on the full URL, so each distinct query caches once.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set('X-Cache', 'HIT');
    return r;
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const segs = Array.isArray(params.path) ? params.path.filter(Boolean) : (params.path ? [params.path] : []);
  const route = segs.join('/').toLowerCase();

  if (!env.ARCHIVE_DB && route !== '') {
    return fail('archive_unavailable', 'The archive is temporarily unreachable. Try again shortly.', 503);
  }

  const store = (res) => {
    // Only successful, cacheable responses are stored; errors carry no-store.
    if (res.ok && waitUntil) {
      const copy = res.clone();
      copy.headers.set('X-Cache', 'MISS');
      try { waitUntil(cache.put(cacheKey, copy)); } catch (_) { /* best effort */ }
    }
    return res;
  };

  try {
    switch (route) {
      case '':             return store(routeIndex(origin));
      case 'stations':     return store(await routeStations(env.ARCHIVE_DB, url));
      case 'latest':       return store(await routeLatest(env.ARCHIVE_DB, url));
      case 'measurements': return store(await routeMeasurements(env.ARCHIVE_DB, url));
      default:
        // Deliberately does NOT echo the requested path back. Reflecting raw
        // caller input into a response body is how a JSON error becomes a
        // delivery vehicle for someone else's payload; the caller already
        // knows what they asked for, and the route list is what's useful.
        return fail('not_found', 'Unknown route. See the available routes below.', 404, {
          available: ['/api/v1', '/api/v1/stations', '/api/v1/latest', '/api/v1/measurements'],
          documentation: `${origin}/api`,
        });
    }
  } catch (err) {
    // Never surface internals (SQL text, bindings, stack) to a public caller.
    console.error('api/v1 error', route, err && err.message);
    return fail('internal_error', 'The request could not be completed.', 500);
  }
}
