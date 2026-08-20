// Cloudflare Pages Function — fetches live air quality data server-side.
// API keys stored in Cloudflare env vars (Settings → Environment Variables),
// never exposed to browser.
// Sources: PurpleAir, AQICN, IQAir, Airly, Nafas (public JSON feed),
// OpenAQ (AirGradient), Smart Citizen (public JSON API, OUTDOOR only).
//
// Edition III iter 5 — first-paint speed pass:
//   1. D1 FAST PATH. If the universal `stations` + `station_snapshots`
//      tables hold a recent (≤ 10 min) snapshot for ≥ 5 stations, serve
//      that response immediately (sub-200 ms). Most visitors hit this path.
//   2. UPSTREAM PARALLEL FALLBACK. When D1 is empty, stale, or sparse,
//      fall through to the upstream aggregator — but every source now runs
//      via Promise.allSettled. The slowest source dictates total time.
//   3. CACHE. Edge cache 1 h, stale-while-revalidate 24 h: subsequent
//      visitors get an instant cached response while we revalidate quietly.

// ── Helpers ───────────────────────────────────────────────────────────
function aqiToPm25(aqi) {
  if (aqi <= 50) return +(aqi * 12.0 / 50).toFixed(1);
  if (aqi <= 100) return +(12.1 + (aqi - 51) * (35.4 - 12.1) / 49).toFixed(1);
  if (aqi <= 150) return +(35.5 + (aqi - 101) * (55.4 - 35.5) / 49).toFixed(1);
  if (aqi <= 200) return +(55.5 + (aqi - 151) * (150.4 - 55.5) / 49).toFixed(1);
  if (aqi <= 300) return +(150.5 + (aqi - 201) * (250.4 - 150.5) / 99).toFixed(1);
  return +(250.5 + (aqi - 301) * (500.4 - 250.5) / 199).toFixed(1);
}
function pm25Category(pm) {
  if (pm == null) return { cat: 'Unknown', cls: 'unknown' };
  if (pm <= 12) return { cat: 'Good', cls: 'good' };
  if (pm <= 25) return { cat: 'Moderate', cls: 'mod' };
  if (pm <= 35.4) return { cat: 'Moderate (above WHO 24hr)', cls: 'mod' };
  if (pm <= 55.4) return { cat: 'Unhealthy for Sensitive Groups', cls: 'usg' };
  if (pm <= 150.4) return { cat: 'Unhealthy', cls: 'unh' };
  if (pm <= 250.4) return { cat: 'Very Unhealthy', cls: 'vunh' };
  return { cat: 'Hazardous', cls: 'haz' };
}
// US-EPA humidity correction for Plantower-based low-cost sensors, applied to
// the two networks on this map that use them raw: AirGradient and PurpleAir.
//
// Why: a Plantower module sizes particles optically, so humid air makes water
// -swollen particles read as more mass than is really there. Uncorrected, Bali's
// 55–70% RH inflates readings by roughly a third to a half. AirGradient applies
// exactly this formula to produce the `pm02Compensated` / `pm02_corrected` field
// shown on their own dashboard — but that field is only exposed on the device's
// LAN API or the token-gated cloud API, never on the anonymous public feed we
// read. The algorithm is published, and we already ingest both inputs, so we
// compute it ourselves rather than display values we know run high.
//
// Bands and coefficients transcribed from AirGradient's published calibration
// algorithms (US EPA 2021 correction for PurpleAir/Plantower). Negative results
// are clamped to 0 per the same guidance.
//
// Caveat, deliberate: AirGradient's official corrected value is a batch-level
// per-device calibration PLUS this EPA formula. The batch factor is unpublished
// and device-specific, so ours is the EPA part only — the dominant term, but not
// bit-identical to their dashboard. The raw value is retained alongside
// (pm25_raw) so this is always reversible and auditable.
function epaCorrectPm25(raw, rh) {
  // Explicit null/empty check BEFORE coercion. Number(null) and Number('') are
  // both 0 — finite — so a bare isFinite test does NOT enforce "need both
  // inputs". Without this: a dead humidity channel silently corrects at RH=0%,
  // the maximum-inflation case (raw 12.0 at a true 65% RH would publish 12.0
  // instead of 6.4, flagged as corrected); and a null raw reading returns ~0.6,
  // publishing and archiving a phantom "Good" value for a sensor reporting no
  // PM2.5 at all. Same coercion trap already fixed in agNum() and scPickSensor().
  // Reject by TYPE first, then coerce. `Number()` maps null, '', [] and false
  // all to a finite 0, so neither a null check nor isFinite alone enforces
  // "need both inputs" — only accepting numbers/numeric strings does.
  const num = (v) => {
    if (v == null || v === '') return NaN;
    if (typeof v !== 'number' && typeof v !== 'string') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const a = num(raw), h = num(rh);
  if (Number.isNaN(a) || Number.isNaN(h)) return null;  // need BOTH inputs
  let v;
  if (a < 30)        v = 0.524 * a - 0.0862 * h + 5.75;
  else if (a < 50) { const f = a / 20 - 1.5;
                     v = (0.786 * f + 0.524 * (1 - f)) * a - 0.0862 * h + 5.75; }
  else if (a < 210)  v = 0.786 * a - 0.0862 * h + 5.75;
  else if (a < 260) { const f = a / 50 - 4.2;
                      v = (0.69 * f + 0.786 * (1 - f)) * a
                        - 0.0862 * h * (1 - f)
                        + 2.966 * f + 5.75 * (1 - f)
                        + 8.84e-4 * a * a * f; }
  else               v = 2.966 + 0.69 * a + 8.84e-4 * a * a;
  return +Math.max(v, 0).toFixed(1);
}

function isRecent(isoStr) {
  if (!isoStr) return false;
  return (Date.now() - new Date(isoStr).getTime()) < SOURCE_STALE_MS.OpenAQ;
}
// Tries to parse upstream `lastSeen` / `till` as a unix-ms timestamp.
// Handles ISO-with-Z, ISO-with-offset, and Nafas's "YYYY-MM-DD HH:MM:SS"
// (which is Asia/Makassar / WITA / UTC+8 — append +08:00 if no zone).
function parseLastSeenMs(s) {
  if (!s) return null;
  let t = String(s).trim();
  if (t.includes(' ') && !t.includes('T')) t = t.replace(' ', 'T');
  // No timezone info → assume WITA (Nafas convention)
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(t)) t = t + '+08:00';
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}
// Stations whose upstream timestamp is older than this threshold are flagged
// stale: true. The frontend renders them muted / dashed so visitors don't
// mistake a frozen sensor for a current reading. 24h = generous; sources
// like IQAir update hourly, AQICN updates hourly, daily-aggregate sources
// could legitimately be 12-18h old without being "broken".
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
// Per-source overrides, for feeds whose own publishing cadence makes the
// generic 24 h far too generous.
//
// OpenAQ (6 h): every Bali OpenAQ station republishes hourly, and it is honest
// about it — its `datetime` advances with each new value and simply stops when
// the upstream device goes quiet, so a reading whose timestamp is hours old is
// genuinely hours old, not a mislabelled fresh one. At 24 h a device could go
// dark mid-morning and still be presented as current air all day; measured
// across the whole OpenAQ archive, 6 h flags 2.0% of polls and lands almost
// entirely on stations that really are lagging (Shiva Industries 77% of polls,
// median reading age 15.5 h) while barely touching healthy ones (Kuwum 0.2%,
// Pantai Nyanyi 0.0%). 6 h is also what fetchOpenAQ already applied via
// isRecent() on the slow path — the fast path rebuilt stations from D1 and
// silently reverted them to 24 h, so identical data was flagged differently
// depending on which path served the request. Both paths now share this table.
//
// AirGradient (6 h): the direct feed timestamps to the minute and normally
// reports every few minutes — measured across the live map, every AirGradient
// station's reading was 5-6 MINUTES old. It kept the generic 24 h only by
// omission. 6 h is 60x its normal cadence — a gap that long is a dead sensor,
// not a slow one, and the pin should say so promptly: a paired station's relay
// stays suppressed either way (see dropOpenAQNearAirGradient), so the muted
// STALE marker is the only honest signal a visitor gets that the unit paused.
//
// Null-prototype so an upstream source string can never reach Object.prototype:
// a station whose source was 'constructor' or 'toString' would otherwise look
// up a function, and `age > <function>` is NaN — false — leaving an
// arbitrarily old reading published as current air. Every source label is a
// hard-coded literal today, so this is a latch on a door that is already shut.
const SOURCE_STALE_MS = Object.assign(Object.create(null), {
  OpenAQ: 6 * 60 * 60 * 1000,
  AirGradient: 6 * 60 * 60 * 1000,
});
function flagStale(station) {
  const ms = parseLastSeenMs(station.lastSeen);
  if (ms == null) return station;
  // ?? not ||, so a future 0 ("always stale") cannot silently become 24 h.
  const limit = SOURCE_STALE_MS[station.source] ?? STALE_THRESHOLD_MS;
  const age = Date.now() - ms;
  if (age > limit) {
    station.stale = true;
    station.staleAgeHours = Math.round(age / 3600000);
  }
  return station;
}
function jsonResponse(body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      // Tight edge cache; stale-while-revalidate keeps hot responses warm
      // for a full day so a single revalidation per hour serves everything.
      // 15-min edge cache aligns with the archive worker's 15-min cron, so the
      // station roster (sensors coming online / going dark) refreshes in step
      // with the data instead of lagging up to an hour. swr keeps it hot.
      'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    }
  });
}

// ── D1 FAST PATH ──────────────────────────────────────────────────────
// One SQL: every station catalog row joined to its most-recent snapshot
// (within the last 30 min — the worker writes every 15 min so this catches
// every station between cron ticks). If we get ≥ 5 fresh rows back, this
// is good enough to serve immediately.
async function fastPathFromD1(db) {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;
  const rows = await db.prepare(`
    SELECT s.station_id, s.source, s.name, s.lat, s.lon, s.type,
           sn.pm25, sn.pm10, sn.pm1, sn.aqi, sn.temperature, sn.humidity,
           sn.station_till, sn.ts, sn.pm25_raw
    FROM stations s
    JOIN station_snapshots sn ON sn.station_id = s.station_id
    WHERE sn.ts = (
      SELECT MAX(ts) FROM station_snapshots WHERE station_id = s.station_id
    )
    AND sn.ts >= ?1
    -- Scraped IQAir stations (iqs-*) are served exclusively by
    -- scrapedIQAirFromD1() from their own iq_scrape_* tables. The archive worker
    -- also snapshots them here via /api/live, but those snapshots carry IQAir's
    -- HOURLY timestamp (>60 min old) so they'd come back flagged stale and
    -- render as a duplicate "offline" pin stacked on the live one. Exclude them
    -- so each scraped station appears exactly once (fresh).
    AND s.station_id NOT LIKE 'iqs-%'
    ORDER BY s.source, s.name
  `).bind(cutoff).all();
  const results = rows.results || [];
  if (results.length < 5) return null;  // not enough fresh data, fall through

  const stations = results.map(r => {
    const pm25 = r.pm25 != null ? +(+r.pm25).toFixed(1) : null;
    const { cat, cls } = pm25Category(pm25);
    return flagStale({
      id: r.station_id,
      name: r.name,
      source: r.source,
      type: r.type || null,
      lat: r.lat,
      lon: r.lon,
      pm25,
      // Carry the correction audit fields on the FAST path too — it's the path
      // most visitors hit, so without these any "corrected" marker in the UI
      // would flicker depending on which path served the request.
      pm25_raw: r.pm25_raw != null ? +(+r.pm25_raw).toFixed(1) : null,
      pm25_corrected: r.pm25_raw != null,
      // Derived from the id prefix rather than carried in the row, so the fast
      // path and contribFromD1() agree by construction. Without it a
      // contributed sensor would count toward the island median on the fast
      // path and not on the slow one — the published figure would depend on
      // which path happened to serve the request.
      contributed: String(r.station_id).startsWith('cs-'),
      pm10: r.pm10 != null ? +(+r.pm10).toFixed(1) : null,
      pm1:  r.pm1  != null ? +(+r.pm1).toFixed(1)  : null,
      aqi: r.aqi != null ? +r.aqi : null,
      temperature: r.temperature != null ? +(+r.temperature).toFixed(1) : null,
      humidity:    r.humidity    != null ? +(+r.humidity).toFixed(1)    : null,
      category: cat,
      cls,
      lastSeen: r.station_till || null,
    });
  });

  const sources = new Set(stations.map(s => s.source)).size;
  return {
    ts: new Date().toISOString(),
    sources,
    stations,
    fast_path: true,            // signals to debug we served from D1
  };
}

// Metres between two lat/lon points (haversine).
function metresBetween(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Scraped IQAir stations (written by the iqair-scrape worker into
// iq_scrape_stations — see workers/iqair-scrape). These are REAL hourly PM2.5
// readings decoded from each IQAir station page, NOT the AQI→PM2.5 estimate the
// nearest_city probe (fetchIQAir) returns. Folded into the 'IQAir' source so
// they share styling with the one real Kopernik node.
//
// De-dup: several IQAir devices ALSO publish to an open network we already read
// (e.g. "Jimbaran" is PurpleAir's "Jimbaran by Lumi Clinic" ~12 m away). Any
// scraped station within DEDUP_M of an already-present DIFFERENT-source station
// is dropped so the native feed wins and there's no double dot. This only ever
// removes scraped IQAir dots — it can never drop an existing one. Stations
// unique to IQAir (the majority) are kept.
//
// Staleness: based on last_scrape_ts (when the worker fetched), not latest_ts
// (IQAir's hourly series lags hours behind its live tile). See FRESH_MS below.
async function scrapedIQAirFromD1(db, existing = []) {
  const DEDUP_M = 300;
  const rows = await db.prepare(`
    SELECT slug, name, lat, lon, latest_pm25, latest_aqi, latest_ts, last_scrape_ts
    FROM iq_scrape_stations
    WHERE active = 1 AND latest_pm25 IS NOT NULL
  `).all();
  const nowMs = Date.now();
  // Liveness is based on when WE last scraped, NOT latest_ts: IQAir's hourly
  // *historic* series lags its live tile by several hours (a 13:08 UTC scrape
  // still ends the hourly series at ~09:00 UTC), so latest_ts is always hours
  // behind even though latest_pm25 is the page's CURRENT reading. The worker
  // scrapes hourly, so 2.5h covers one missed cron before a station is stale.
  const FRESH_MS = 2.5 * 60 * 60 * 1000;
  const out = [];
  for (const r of (rows.results || [])) {
    if (r.lat == null || r.lon == null) continue;
    const dup = existing.some(o =>
      o && o.source !== 'IQAir' &&
      Number.isFinite(o.lat) && Number.isFinite(o.lon) &&
      metresBetween(r.lat, r.lon, o.lat, o.lon) < DEDUP_M
    );
    if (dup) continue;
    const pm25 = r.latest_pm25 != null ? +(+r.latest_pm25).toFixed(1) : null;
    const { cat, cls } = pm25Category(pm25);
    const scrapeAgeMs = r.last_scrape_ts ? (nowMs - r.last_scrape_ts * 1000) : Infinity;
    out.push({
      id: `iqs-${r.slug}`,
      name: r.name,
      source: 'IQAir',
      type: 'Private sensor',
      lat: r.lat,
      lon: r.lon,
      pm25,
      aqi: r.latest_aqi != null ? +r.latest_aqi : null,
      category: cat,
      cls,
      lastSeen: r.latest_ts || null,
      stale: scrapeAgeMs > FRESH_MS,
    });
  }
  return out;
}

// ── UPSTREAM SOURCE FETCHERS — each returns an array of station objects ──
// All fetchers run in parallel via Promise.allSettled.

async function fetchPurpleAir(env) {
  // Whole-Bali bbox (north -8.0 → south -8.92, west 114.4 → east 115.78)
  const r = await fetch(
    'https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,pm2.5,pm2.5_cf_1,humidity,last_seen&location_type=0&nwlat=-8.0&nwlng=114.4&selat=-8.92&selng=115.78',
    { headers: { 'X-API-Key': env.PURPLEAIR_API_KEY } }
  );
  const data = await r.json();
  if (!data?.data) return [];
  const f = data.fields;
  return data.data.map(row => {
    // PurpleAir is Plantower-based like AirGradient, so it carries the same
    // humidity over-read. `humidity` was added to the field list for exactly
    // this — correct when it's present, fall back to raw when it isn't (a
    // sensor with a dead RH channel still reports, just uncorrected).
    // Correction INPUT is cf_1, not atm. The EPA regression was fitted on
    // PurpleAir CF=1 data; the `pm2.5` (ATM) field applies its own high-range
    // scaling, so feeding ATM under-corrects above ~25 µg/m³ — precisely the
    // burn events this site exists to document. Measured on both Bali sensors:
    // identical to ATM at current levels, so this is a no-op day to day and
    // only bites when it matters. Falls back to ATM if cf_1 is unavailable.
    const atm = row[f.indexOf('pm2.5')];
    const cf1 = f.indexOf('pm2.5_cf_1') >= 0 ? row[f.indexOf('pm2.5_cf_1')] : null;
    const raw = cf1 != null ? cf1 : atm;
    const rh = f.indexOf('humidity') >= 0 ? row[f.indexOf('humidity')] : null;
    const corrected = epaCorrectPm25(raw, rh);
    const pm = corrected != null ? corrected : (raw != null ? +raw.toFixed(1) : null);
    const { cat, cls } = pm25Category(pm);
    return {
      id: `pa-${row[0]}`,
      name: row[f.indexOf('name')],
      source: 'PurpleAir',
      type: 'Community sensor',
      lat: row[f.indexOf('latitude')],
      lon: row[f.indexOf('longitude')],
      pm25: pm,
      // pm25_raw stores the exact value fed into the correction, so the
      // invariant epaCorrectPm25(pm25_raw, humidity) === pm25 holds for every
      // archived row and the correction stays reproducible from stored fields.
      pm25_raw: raw != null ? +raw.toFixed(1) : null,
      pm25_corrected: corrected != null,
      // Same coercion trap: +null === 0 is finite, which would archive a real
      // "0% relative humidity in Bali" into the humidity column — and worse,
      // make the row look like it HAS valid RH to any later re-correction pass.
      humidity: (rh == null || rh === '' || !Number.isFinite(+rh)) ? null : +(+rh).toFixed(1),
      aqi: null,
      category: cat,
      cls,
      lastSeen: row[f.indexOf('last_seen')]
        ? new Date(row[f.indexOf('last_seen')] * 1000).toISOString()
        : null,
    };
  });
}

async function fetchAQICN(env) {
  // 1. /v2/map/bounds returns @-prefix GAIA-network stations within bbox.
  //    Per-station detail is fetched in PARALLEL (was sequential).
  // 2. THEN we additionally probe a curated list of A-prefix stations (the
  //    AQICN bounds endpoint does NOT include them — these are typically
  //    government-grade reference instruments that publish through AQICN's
  //    data platform but aren't enumerated on the GAIA map). For Bali we
  //    currently track:
  //      - A416893  Denpasar Lumintang (KLHK government PM2.5 reference)
  //    Any new A-prefix Bali stations: just add to AQICN_DIRECT below.
  const AQICN_DIRECT = [
    { id: 'A416893', name: 'Denpasar Lumintang', type: 'Government (KLHK)' },
  ];

  const out = [];

  // ── (1) bbox-discovered GAIA stations ──
  try {
    const r = await fetch(
      `https://api.waqi.info/v2/map/bounds?latlng=-8.92,114.4,-8.0,115.78&networks=all&token=${env.AQICN_TOKEN}`
    );
    const data = await r.json();
    if (data.status === 'ok' && Array.isArray(data.data)) {
      const details = await Promise.all(data.data.map(async (s) => {
        try {
          const dr = await fetch(`https://api.waqi.info/feed/@${s.uid}/?token=${env.AQICN_TOKEN}`);
          const dd = await dr.json();
          return { s, dd };
        } catch { return { s, dd: null }; }
      }));
      for (const { s, dd } of details) {
        const pm25 = dd?.data?.iaqi?.pm25?.v;
        const { cat, cls } = pm25Category(pm25);
        const attribution = dd?.data?.attributions?.[0]?.name || '';
        const isGov = attribution.includes('KLHK') || attribution.includes('Kementerian');
        out.push({
          id: `aq-${s.uid}`,
          name: s.station?.name || 'Unknown',
          source: 'AQICN',
          type: isGov ? 'Government (KLHK)' : 'GAIA Network',
          lat: s.lat, lon: s.lon,
          pm25: pm25 != null ? +pm25 : null,
          aqi: +s.aqi || null,
          category: cat, cls,
          lastSeen: dd?.data?.time?.iso || null,
        });
      }
    }
  } catch (_) { /* swallow; direct path below still runs */ }

  // ── (2) curated A-prefix direct probes (government reference stations) ──
  await Promise.all(AQICN_DIRECT.map(async (entry) => {
    try {
      const r = await fetch(`https://api.waqi.info/feed/${entry.id}/?token=${env.AQICN_TOKEN}`);
      const dd = await r.json();
      if (dd?.status !== 'ok' || !dd.data) return;
      const pm25 = dd.data.iaqi?.pm25?.v;
      // Sanity check: AQICN's free-tier sometimes maps unknown ids to wrong
      // stations (we saw idx=-419824 / Bend, Oregon with the demo token).
      // Only accept when the geo lands in Bali bbox.
      const geo = dd.data.city?.geo;
      if (!Array.isArray(geo) || geo.length < 2) return;
      const [lat, lon] = geo;
      if (lat < -9.2 || lat > -8.0 || lon < 114.4 || lon > 115.8) return;
      const { cat, cls } = pm25Category(pm25);
      out.push({
        id: `aq-${entry.id}`,
        name: dd.data.city?.name || entry.name,
        source: 'AQICN',
        type: entry.type,
        lat, lon,
        pm25: pm25 != null ? +pm25 : null,
        aqi: dd.data.aqi != null ? +dd.data.aqi : null,
        category: cat, cls,
        lastSeen: dd.data.time?.iso || null,
      });
    } catch (_) { /* skip this direct probe */ }
  }));

  // De-dupe: a station could in theory appear in both bbox + direct paths
  const seen = new Set();
  const dedup = [];
  for (const s of out) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    dedup.push(s);
  }
  return dedup;
}

async function fetchAirly(env) {
  // Aggressive cf cache: nearest 2h, measurements 1h. Free-tier safe.
  const resp = await fetch(
    'https://airapi.airly.eu/v2/installations/nearest?lat=-8.55&lng=115.26&maxDistanceKM=100&maxResults=50',
    {
      headers: { Accept: 'application/json', apikey: env.AIRLY_API_KEY },
      cf: { cacheTtl: 7200, cacheEverything: true }
    }
  );
  if (resp.status === 429) throw new Error('Airly 429');
  const installations = await resp.json();
  if (!Array.isArray(installations) || installations.length === 0) return [];

  const measurements = await Promise.all(installations.map(async (inst) => {
    try {
      const mr = await fetch(
        `https://airapi.airly.eu/v2/measurements/installation?installationId=${inst.id}`,
        {
          headers: { Accept: 'application/json', apikey: env.AIRLY_API_KEY },
          cf: { cacheTtl: 3600, cacheEverything: true }
        }
      );
      if (mr.status === 429) return { inst, md: null };
      const md = await mr.json();
      return { inst, md };
    } catch { return { inst, md: null }; }
  }));

  return measurements.flatMap(({ inst, md }) => {
    const cur = md?.current;
    if (!cur) return [];
    let pm25=null, pm1=null, pm10=null, temp=null, humidity=null;
    for (const v of (cur.values||[])) {
      if (v.name==='PM25') pm25=+v.value.toFixed(1);
      else if (v.name==='PM1') pm1=+v.value.toFixed(1);
      else if (v.name==='PM10') pm10=+v.value.toFixed(1);
      else if (v.name==='TEMPERATURE') temp=+v.value.toFixed(1);
      else if (v.name==='HUMIDITY') humidity=+v.value.toFixed(1);
    }
    const { cat, cls } = pm25Category(pm25);
    const addr = inst.address||{};
    const sponsor = inst.sponsor?.name||'';
    return [{
      id: `airly-${inst.id}`,
      name: [addr.displayAddress1, addr.displayAddress2].filter(Boolean).join(', ') || `Airly #${inst.id}`,
      source: 'Airly',
      type: sponsor ? `${sponsor}-sponsored Airly sensor` : 'Airly sensor',
      lat: inst.location?.latitude,
      lon: inst.location?.longitude,
      pm25, pm1, pm10, temperature: temp, humidity,
      aqi: cur.indexes?.[0]?.value ? +cur.indexes[0].value.toFixed(0) : null,
      category: cat,
      cls,
      lastSeen: cur.tillDateTime || null,
    }];
  });
}

async function fetchNafas() {
  const allResp = await fetch('https://outdoor.nafas.co.id/api/v1/location/all', {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 300, cacheEverything: true },  // bumped from 180 → 300
  });
  if (!allResp.ok) return [];
  const allData = await allResp.json();
  if (!allData?.success || !Array.isArray(allData.body)) return [];
  const BALI = { latMin: -9.2, latMax: -8.0, lonMin: 114.4, lonMax: 115.8 };
  const baliStations = allData.body.filter(loc => {
    const lat = +loc.latitude, lon = +loc.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (loc.visible === false) return false;
    return lat >= BALI.latMin && lat <= BALI.latMax &&
           lon >= BALI.lonMin && lon <= BALI.lonMax;
  });
  const details = await Promise.all(baliStations.map(async (loc) => {
    try {
      const dr = await fetch(`https://outdoor.nafas.co.id/api/v1/location/detail/${loc.uuid}`, {
        headers: { Accept: 'application/json' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!dr.ok) return { loc, detail: null };
      const dd = await dr.json();
      return { loc, detail: dd?.body || null };
    } catch { return { loc, detail: null }; }
  }));
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = +v;
    return Number.isFinite(n) ? +n.toFixed(1) : null;
  };
  return details.map(({ loc, detail }) => {
    const d = detail || loc;
    const pm25 = num(d.pm25);
    const { cat, cls } = pm25Category(pm25);
    const aqi = d.aqi != null ? +d.aqi : (loc.aqi != null ? +loc.aqi : null);
    return {
      id: `nafas-${loc.uuid}`,
      name: loc.name || `Nafas ${String(loc.uuid).slice(0,8)}`,
      source: 'Nafas',
      type: 'Nafas Foundation sensor',
      lat: +loc.latitude,
      lon: +loc.longitude,
      pm25,
      pm1: num(d.pm1),
      pm10: num(d.pm10),
      temperature: num(d.temperature),
      humidity: num(d.humidity),
      aqi: Number.isFinite(aqi) ? aqi : null,
      category: cat,
      cls,
      lastSeen: d.till || loc.till || null,
      nafas_uuid: loc.uuid,
    };
  });
}

// ── Smart Citizen (smartcitizen.me — public JSON API, no key) ───────────
// OUTDOOR ONLY. Smart Citizen is a citizen-science network; every device
// publishes location.exposure ('outdoor'|'indoor') plus an online/offline tag.
// We surface ONLY currently-online OUTDOOR devices inside the Bali bbox that
// carry a PM2.5 sensor. Indoor devices are NEVER surfaced — this map is outdoor
// ambient air; an indoor reading is not comparable and must not appear.
//
// One request does it all: /v0/devices?near=<lat,lon>&distance=<m> returns the
// device list WITH inline sensor values (.data.sensors[].value), so there is no
// N+1 detail fetch (unlike Nafas). The filter is dynamic — any NEW outdoor SC
// device that comes online in Bali appears automatically; there is no hardcoded
// device list to maintain. Indoor devices can never slip in.
//
// De-dup: SC's Jimbaran test cluster has two units ~11 m apart — collapse
// SC-internal near-duplicates here (keep the freshest). Cross-source de-dup
// (drop an SC pin sitting on an existing PurpleAir/Nafas/etc. sensor) is applied
// by the caller via dedupSmartCitizen(), mirroring scrapedIQAirFromD1.
const SC_BALI = { latMin: -9.2, latMax: -8.0, lonMin: 114.4, lonMax: 115.8 };
function scPickSensor(sensors, re) {
  if (!Array.isArray(sensors)) return null;
  const s = sensors.find(x => re.test(String(x?.name || '')));
  // Explicit null/empty check BEFORE coercion (same fix as agNum in
  // fetchAirGradient): a sensor entry with value:null — a dead module on a
  // live device — would otherwise coerce via `+null === 0` into a phantom
  // 0.0 reading that gets displayed and archived as false clean air.
  const v = (s && s.value != null && s.value !== '') ? +s.value : NaN;
  return Number.isFinite(v) ? +v.toFixed(1) : null;
}
// Sanitise externally-controlled SC strings (device name / hardware label) at
// the source boundary. Smart Citizen lets anyone name a device anything and
// bring it online in Bali; the frontend injects names via innerHTML, so strip
// the HTML/attribute breakout characters here so a hostile device name can never
// reach the DOM as markup. (Pre-existing site-wide pattern for other sources is
// flagged separately; this keeps the source WE add self-contained-safe.)
function scClean(s) {
  return String(s == null ? '' : s).replace(/[<>"`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
async function fetchSmartCitizen() {
  // Bali centre + 80 km radius covers the whole island in a single request.
  const r = await fetch(
    'https://api.smartcitizen.me/v0/devices?near=-8.65,115.20&distance=80000&per_page=200',
    { headers: { Accept: 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!r.ok) return [];
  const list = await r.json();
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    // HARD RULE #1: outdoor only. Never surface indoor devices.
    if (d?.location?.exposure !== 'outdoor') continue;
    // HARD RULE #2: live only. Skip anything not currently online.
    const tags = Array.isArray(d.system_tags) ? d.system_tags : [];
    if (!tags.includes('online') || tags.includes('offline')) continue;
    const lat = +d.location?.latitude, lon = +d.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < SC_BALI.latMin || lat > SC_BALI.latMax ||
        lon < SC_BALI.lonMin || lon > SC_BALI.lonMax) continue;
    // Device id must be a clean integer — the station_id (sc-<id>) is used as a
    // D1 key and a history route param; reject anything non-numeric outright.
    const devId = Number.parseInt(d.id, 10);
    if (!Number.isFinite(devId) || String(devId) !== String(d.id)) continue;
    const sensors = d.data?.sensors;
    const pm25 = scPickSensor(sensors, /PM2\.5/i);
    if (pm25 == null) continue;  // must carry a real PM2.5 reading
    // Backstop staleness guard: if the 'online' tag lingers but the last reading
    // is absurdly old (>24h), skip. A genuinely online SC device reports ~1/min.
    const lastMs = d.last_reading_at ? Date.parse(d.last_reading_at) : NaN;
    if (Number.isFinite(lastMs) && (Date.now() - lastMs) > 24 * 60 * 60 * 1000) continue;
    const { cat, cls } = pm25Category(pm25);
    out.push({
      id: `sc-${devId}`,
      name: scClean(d.name) || `Smart Citizen #${devId}`,
      source: 'Smart Citizen',
      type: scClean(d.hardware?.name) || 'Citizen sensor',
      lat, lon,
      pm25,
      pm10: scPickSensor(sensors, /PM10/i),
      pm1:  scPickSensor(sensors, /PM1\b/i),
      temperature: scPickSensor(sensors, /Temperature/i),
      humidity:    scPickSensor(sensors, /Humidity/i),
      aqi: null,
      category: cat,
      cls,
      lastSeen: d.last_reading_at || null,
    });
  }
  // SC-internal co-location de-dup: collapse pins within 120 m of each other
  // (the Jimbaran twins sit ~11 m apart). Tiebreak is the LOWEST device id —
  // a STABLE choice (the same station_id always wins, so history never splits),
  // and lowest id == oldest device == longest history. Liveness is already
  // handled upstream: offline units are filtered out before this runs, so if the
  // winning unit goes dark its co-located sibling is naturally kept next tick.
  const INTERNAL_M = 120;
  const devNum = (s) => { const n = +String(s.id).slice(3); return Number.isFinite(n) ? n : Infinity; };
  const kept = [];
  for (const s of out.sort((a, b) => devNum(a) - devNum(b))) {  // lowest id first
    if (kept.some(k => metresBetween(s.lat, s.lon, k.lat, k.lon) < INTERNAL_M)) continue;
    kept.push(s);
  }
  return kept;
}

// Drop Smart Citizen pins within 300 m of an already-present DIFFERENT-source
// station (mirrors scrapedIQAirFromD1's de-dup). Only ever removes SC pins —
// never an existing one. Future-proofs against an SC unit placed beside a
// PurpleAir/Nafas/etc. device so the native feed wins and there's no double dot.
function dedupSmartCitizen(scStations, existing) {
  const DEDUP_M = 300;
  return scStations.filter(s =>
    !existing.some(o =>
      o && o.source !== 'Smart Citizen' &&
      Number.isFinite(o.lat) && Number.isFinite(o.lon) &&
      metresBetween(s.lat, s.lon, o.lat, o.lon) < DEDUP_M
    )
  );
}

// ── AirGradient — direct public world feed (keyless) ─────────────────────
// AirGradient units in Bali normally reach us through OpenAQ (Kuwum, Tabanan),
// but the AirGradient→OpenAQ registration of NEW locations can lag by weeks —
// "Padang2 Uluwatu" (location 197980) was live on AirGradient for two weeks
// while completely absent from OpenAQ's /locations. Pulling the public feed
// directly removes that delay: any new Bali AirGradient unit appears as soon
// as it publishes. No key, one request, world feed filtered to the Bali bbox.
//
// De-dup DEFERS to every existing source (300 m): Kuwum + Tabanan keep their
// established OpenAQ identity (oq-*) so their D1 history stays continuous;
// only genuinely new units (Padang2) surface with an ag-* id. Names and model
// strings are attacker-controllable (anyone can name an AirGradient location
// anything), so they pass through scClean() at this source boundary exactly
// like Smart Citizen names.
const AG_BALI = { latMin: -9.2, latMax: -8.0, lonMin: 114.4, lonMax: 115.8 };
async function fetchAirGradient() {
  const r = await fetch(
    'https://api.airgradient.com/public/api/v1/world/locations/measures/current',
    { headers: { Accept: 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!r.ok) return [];
  const list = await r.json();
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    const lat = +d?.latitude, lon = +d?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < AG_BALI.latMin || lat > AG_BALI.latMax ||
        lon < AG_BALI.lonMin || lon > AG_BALI.lonMax) continue;
    if (d.offline === true) continue;           // feed marks dead units itself
    // location id must be a clean integer — used as a D1 key + history param.
    const devId = Number.parseInt(d.locationId, 10);
    if (!Number.isFinite(devId) || String(devId) !== String(d.locationId)) continue;
    // Explicit null/empty check BEFORE numeric coercion: the world feed always
    // sends every key and uses null for missing data (verified: 2,528/2,528
    // entries), and units whose PM module died while WiFi stayed up carry
    // pm02:null with offline:false. `+null === 0` is finite, so without this
    // guard a dead module would render — and archive — a phantom 0.0 "Good"
    // reading: false clean-air record, the worst failure direction possible.
    const agNum = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +(+v).toFixed(1);
    const pm25Raw = agNum(d.pm02);
    if (pm25Raw == null) continue;              // must carry a real PM2.5 reading
    // Publish the humidity-corrected value (see epaCorrectPm25) — the public
    // feed only exposes raw pm02, and raw runs high in Bali's humidity. Keep
    // the raw figure alongside so the correction stays auditable/reversible.
    const rhum = agNum(d.rhum);
    const pm25Corrected = epaCorrectPm25(pm25Raw, rhum);
    const pm25 = pm25Corrected != null ? pm25Corrected : pm25Raw;
    // Staleness backstop (mirrors Smart Citizen): if the feed's own timestamp
    // is >24 h old despite offline:false, don't surface it as live air. A
    // MISSING/unparseable timestamp fails this check too, not just an old one:
    // healthy units always carry one (the world feed sends every key, null for
    // missing), and an entry that cannot prove its freshness would otherwise
    // sail past flagStale forever — lastSeen null means "never goes stale",
    // which for a paired unit would suppress its OpenAQ twin indefinitely.
    const lastMs = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!Number.isFinite(lastMs) || (Date.now() - lastMs) > 24 * 60 * 60 * 1000) continue;
    const { cat, cls } = pm25Category(pm25);
    out.push({
      id: `ag-${devId}`,
      name: scClean(d.publicLocationName || d.locationName) || `AirGradient #${devId}`,
      source: 'AirGradient',
      type: scClean('AirGradient ' + (d.model || 'monitor')),
      lat, lon,
      pm25,
      pm25_raw: pm25Raw,
      pm25_corrected: pm25Corrected != null,
      pm10: agNum(d.pm10),
      pm1:  agNum(d.pm01),
      temperature: agNum(d.atmp),
      humidity:    rhum,
      aqi: null,
      category: cat,
      cls,
      lastSeen: d.timestamp || null,
    });
  }
  return out;
}

// Drop AirGradient pins within 300 m of an already-present DIFFERENT-source
// station, so established identities and their archived history win — EXCEPT
// against OpenAQ, which is exempt.
//
// Why OpenAQ is exempt: an OpenAQ neighbour is usually not a different sensor
// at all, it IS this AirGradient unit relayed through OpenAQ (verified 0 m for
// Kuwum and Tabanan). Deferring there would discard the direct feed and keep
// only the ~hourly re-aggregated copy — the worse of two records of the same
// hardware, and the AG station would never be archived at all. So both are
// admitted here and both get archived (oq-* history stays continuous under its
// own id; ag-* builds a clean raw 15-min record), and the DISPLAY choice is
// made later, on every visitor-served path, by dropOpenAQNearAirGradient().
function dedupAirGradient(agStations, existing) {
  const DEDUP_M = 300;
  return agStations.filter(a =>
    !existing.some(o =>
      o && o.source !== 'AirGradient' && o.source !== 'OpenAQ' &&
      Number.isFinite(o.lat) && Number.isFinite(o.lon) &&
      metresBetween(a.lat, a.lon, o.lat, o.lon) < DEDUP_M
    )
  );
}

// Smart Citizen OFFLINE retention — grey "tombstone" pins for units that stop
// being eligible live outdoor sensors, so months of archived readings never
// silently vanish from the map/history the moment a device dies (Pangkung
// Tibah, Jul 2026) or its owner retags it indoor (SCK@Jimbaran, Jul 2026).
//
// Driven entirely by OUR D1 archive (stations catalog + station_daily), not by
// upstream tags — so it works identically on the fast path and even if the
// device is deleted from the Smart Citizen API. Gates keep it curated:
//   • ≥ MIN_DAILY_DAYS archived days — flapping hobby nodes and week-old test
//     blips never earn a tombstone;
//   • last archived day within RETENTION_DAYS — long-dark units age off the
//     map (their history stays in D1 + /api/history forever);
//   • ≥ NEAR_M from any live SC pin — a live sibling covers the spot (Kios
//     Utak Atik: the live board suppresses the dead node 10 m away); among
//     co-located dead twins the lowest id (= longest record) wins, so
//     SCK@Jimbaran-2025 absorbs SCK-TWO 11 m away — one pin, one record.
// Tombstones are EXEMPT from cross-source de-dup: they mark a distinct dead
// device whose record must stay reachable; a live foreign sensor nearby does
// not make that history redundant. Always additive, never blocking: any D1
// failure returns [] and live air is served unchanged.
async function scOfflineFromD1(db, baseStations) {
  const RETENTION_DAYS = 90;
  const MIN_DAILY_DAYS = 5;
  const NEAR_M = 120;          // matches the SC-internal live de-dup radius
  try {
    const rows = await db.prepare(`
      SELECT st.station_id AS id, st.name, st.lat, st.lon, st.type,
             d.days, d.last_date
      FROM stations st
      JOIN (SELECT station_id, COUNT(*) AS days, MAX(date) AS last_date
              FROM station_daily WHERE station_id LIKE 'sc-%'
             GROUP BY station_id) d ON d.station_id = st.station_id
      WHERE st.station_id LIKE 'sc-%'
    `).all();
    const present = new Set((baseStations || []).map(s => s && s.id).filter(Boolean));
    const anchors = (baseStations || []).filter(s =>
      s && s.source === 'Smart Citizen' &&
      Number.isFinite(+s.lat) && Number.isFinite(+s.lon));
    const nowMs = Date.now();
    const devNum = (id) => { const n = +String(id).slice(3); return Number.isFinite(n) ? n : Infinity; };
    const out = [];
    for (const r of (rows.results || []).sort((a, b) => devNum(a.id) - devNum(b.id))) {
      if (!r || present.has(r.id)) continue;               // currently live on the map
      if (+r.days < MIN_DAILY_DAYS) continue;
      // End of the last archived WITA day — a unit that reported yesterday
      // evening local time isn't "36h dead" just because dates are UTC-naive.
      const lastMs = Date.parse(String(r.last_date) + 'T23:59:59+08:00');
      if (!Number.isFinite(lastMs)) continue;
      if (nowMs - lastMs > RETENTION_DAYS * 86400000) continue;
      // Explicit null check first: +null coerces to 0, which Number.isFinite
      // accepts — a NULL-coord catalog row would otherwise pin at (0,0).
      if (r.lat == null || r.lon == null ||
          !Number.isFinite(+r.lat) || !Number.isFinite(+r.lon)) continue;
      if (anchors.some(a => metresBetween(+r.lat, +r.lon, +a.lat, +a.lon) < NEAR_M)) continue;
      if (out.some(k => metresBetween(+r.lat, +r.lon, k.lat, k.lon) < NEAR_M)) continue;
      out.push({
        id: r.id,
        name: r.name || r.id,
        source: 'Smart Citizen',
        type: r.type || 'Citizen sensor',
        lat: +r.lat, lon: +r.lon,
        pm25: null, pm10: null, pm1: null, aqi: null,
        temperature: null, humidity: null,
        category: null, cls: 'off',
        off: true,                          // frontends: offline family, not live
        offlineSince: String(r.last_date),  // last archived day (YYYY-MM-DD)
        // Clamp to now: a device whose last archived day is today would
        // otherwise report a future lastSeen / negative staleAgeHours.
        lastSeen: new Date(Math.min(lastMs, nowMs)).toISOString(),
        stale: true,                        // never counted as a current reading
        staleAgeHours: Math.max(0, Math.round((nowMs - lastMs) / 3600000)),
      });
    }
    return out;
  } catch (_) {
    return [];  // tombstones are optional — never break live air
  }
}

// Community-contributed sensors (cs-*) — residents running their own hardware
// who POST to /api/ingest. Their readings already live in the universal
// stations/station_snapshots tables, so the D1 FAST path picks them up with no
// special handling. This function exists for the SLOW path only: that path
// rebuilds the station list from upstream APIs, and a pushed sensor has no
// upstream to poll, so without this it would vanish whenever the fast path
// wasn't used (including for the archive worker, which reads ?fresh=1).
//
// `contributed: true` is what the frontend keys off to keep these out of the
// island-wide statistics — unverified siting must not move a published health
// figure. Never blocking: any failure returns [] and live air is served
// unchanged.
async function contribFromD1(db, existing = []) {
  const FRESH_MS = 60 * 60 * 1000;   // pushed sensors report far more often
  try {
    const rows = await db.prepare(`
      SELECT s.station_id, s.name, s.lat, s.lon, s.type,
             sn.pm25, sn.pm10, sn.pm1, sn.temperature, sn.humidity, sn.ts
      FROM stations s
      JOIN station_snapshots sn ON sn.station_id = s.station_id
      WHERE s.station_id LIKE 'cs-%'
        AND sn.ts = (SELECT MAX(ts) FROM station_snapshots WHERE station_id = s.station_id)
    `).all();
    const present = new Set((existing || []).map(s => s && s.id).filter(Boolean));
    const out = [];
    for (const r of (rows.results || [])) {
      if (!r || present.has(r.station_id)) continue;
      if (r.lat == null || r.lon == null) continue;
      const pm25 = r.pm25 != null ? +(+r.pm25).toFixed(1) : null;
      const { cat, cls } = pm25Category(pm25);
      const lastMs = (+r.ts) * 1000;
      out.push({
        id: r.station_id,
        name: r.name || r.station_id,
        source: 'Community',
        type: r.type || 'Community sensor',
        lat: +r.lat, lon: +r.lon,
        pm25,
        pm25_raw: null,
        pm25_corrected: false,
        pm10: r.pm10 != null ? +(+r.pm10).toFixed(1) : null,
        pm1:  r.pm1  != null ? +(+r.pm1).toFixed(1)  : null,
        aqi: null,
        temperature: r.temperature != null ? +(+r.temperature).toFixed(1) : null,
        humidity:    r.humidity    != null ? +(+r.humidity).toFixed(1)    : null,
        category: cat, cls,
        contributed: true,
        lastSeen: new Date(lastMs).toISOString(),
        stale: (Date.now() - lastMs) > FRESH_MS,
      });
    }
    return out;
  } catch (_) {
    return [];   // contributed sensors are additive — never break live air
  }
}

// Airly de-dup (display only). Both Bali Airly installations are Nafas-SPONSORED
// hardware co-located (~12 m) with a Nafas station, publishing the same readings
// (daily-mean r≈0.97, mean |Δ|<1 µg/m³). Show one pin: drop any Airly station
// within 300 m of a FRESH (non-stale) Nafas station. If Nafas isn't reporting
// that spot, the Airly is kept → automatic failover to the redundant feed.
// Applied ONLY to what a VISITOR is served, on either path. The archive worker
// is the sole caller passing ?fresh=1, which skips these folds, so it keeps
// snapshotting BOTH into D1 — the failover history is preserved and the Airly
// reappears the moment Nafas goes quiet.
function dropAirlyNearNafas(stations) {
  const DEDUP_M = 300;
  const freshNafas = stations.filter(s =>
    s && s.source === 'Nafas' && !s.stale &&
    Number.isFinite(s.pm25) &&   // a blank Nafas pin must not hide a live Airly reading
    Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!freshNafas.length) return stations;  // no live Nafas → keep Airly (failover)
  return stations.filter(s => {
    if (!s || s.source !== 'Airly' || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return true;
    return !freshNafas.some(n => metresBetween(s.lat, s.lon, n.lat, n.lon) < DEDUP_M);
  });
}

// OpenAQ ↔ AirGradient de-dup (display only) — prefer the DIRECT feed.
// Bali's AirGradient units reach us twice: once straight from AirGradient's
// public feed (ag-*), once relayed through OpenAQ (oq-*). Every Bali OpenAQ
// station is such a relay. The relayed copy is materially worse: OpenAQ
// republishes ~hourly (our archive shows those stations' values moving only
// every ~1.3-1.4 h despite 15-min polling) while the direct feed is
// instantaneous and timestamped to the minute — a live spot-check had Tabanan
// at 10.3 via OpenAQ against 6.5 raw via AirGradient at the same moment. The
// direct feed is also the one we humidity-correct (see epaCorrectPm25); OpenAQ
// rows are published exactly as OpenAQ supplies them and are never corrected,
// so preferring the relay would quietly show an uncorrected number instead.
// So: collapse each relay pair onto ONE pin — the direct feed, always. There is
// deliberately NO numeric failover to the relay: swapping in the uncorrected
// figure whenever AirGradient pauses made the same pin jump 20-45% between two
// different numbers for the same air. Measured over each pair's coexistence,
// AirGradient was up 91-100% of hours, so the relay was buying at most a few
// percent of coverage at the cost of that inconsistency — and the relay itself
// goes quiet often enough (3 of 5 relay pins were stale the day this was
// decided) that it could not be counted on for even that. When the direct feed
// goes quiet, the pin goes honestly STALE — muted, excluded from the published
// figures — rather than borrowing the higher raw number. If the AirGradient
// unit drops off the feed entirely, no pair forms and the OpenAQ record stands
// on its own again, exactly like any station we cannot pair.
//
// Applied ONLY to what a VISITOR is served. The archive worker reads the slow
// path with ?fresh=1, which skips this entirely, so oq-* history stays
// continuous and untouched under its own id while ag-* builds a clean raw
// 15-min record. Both remain fully published through /api/v1.
//
// PAIRING IS DISCOVERED, NOT LISTED. This used to be a hand-maintained map of
// three verified ids, on the reasoning that geometry alone is unsafe: an
// unrelated AirGradient unit parked a couple of hundred metres from an
// OpenAQ-only station would silently delete a genuine distinct sensor. That
// reasoning was sound for a 300 m radius, but the list could not keep up —
// every Bali OpenAQ station turns out to be an AirGradient relay, and by the
// time this was rewritten 9 of 12 pairs were double-pinned, inflating the live
// station count and counting one physical device twice in the median and WHO
// ratio. Two facts make discovery strictly SAFER than that 300 m rule:
//   • the relay reports the device's coordinates unchanged — all 12 pairs match
//     at exactly 0.000000 m, not "nearby", so TWIN_M is 1 m rather than 300;
//   • OpenAQ names the instrument itself in provider.name, which live.js
//     carries through as `type` ("AirGradient sensor").
// Together these keep the blast radius to relays only: a relay of any other
// network never matches the type check, and an unrelated AirGradient unit
// merely nearby never matches at 1 m. Note the type test is one-sided — it is
// a property of the OpenAQ station being suppressed, not a cross-check against
// the AirGradient one doing the suppressing, so it distinguishes "is this a
// relay at all" and not "is this the RIGHT device". Only the coordinate match
// and the id tiebreak below speak to the latter.
const TWIN_M = 1;
// PAIRING IS IMMEDIATE. A 24 h archive-settling gate used to stand here, so a
// freshly-registered AirGradient unit could not claim a twin straight away.
// It was removed on 2026-08-20: the cost was paid every time a real sensor
// came online — the pair double-pinned for a day, and because the two markers
// sit at 0.000000 m the OpenAQ pin landed ON TOP, showing its uncorrected
// number (Nyambu 48.4 against the true 26.2, Sogil Brew 67.5 against 15.5) and
// making the correct pin unclickable. AirGradient has been adding a Bali unit
// roughly daily, so that was close to a permanent condition on the newest
// sensors — the ones people go looking for.
//
// What the gate defended, and what still does. The attack is an impostor
// registering a unit at a victim relay's exact coordinates to make that relay
// vanish. Suppression removes the OpenAQ COPY; the impostor's own ag-* pin is
// normally drawn either way (the one exception is the blank-pin rule below,
// which drops a value-less ag-* rather than let it bury a live reading). Note
// that an impostor pin, like any fresh station, DOES enter the published
// median / WHO count / worst-now — that is true with or without pairing, and
// is not something this de-dup can address. Two cases:
//   • the genuine AirGradient twin is present — the ordinary case for every
//     current pair. Two ag-* units then sit at one coordinate and the tiebreak
//     below takes the lowest id, which is the longer-established device; ids
//     are issued in ascending order, so an impostor cannot outrank a unit
//     registered earlier. The real pin keeps showing its corrected value and
//     what got suppressed is the duplicate we no longer want anyway.
//   • the genuine twin has dropped off the feed, leaving the relay as the only
//     record of that spot. This is the case with real exposure. The
//     anti-burying guard below is all that holds it, and it holds a narrower
//     line than is comfortable: it caps UNDERSTATEMENT AT A RATIO, not at an
//     absolute level. An impostor publishing a third of the relay's figure
//     suppresses it at ANY level — 300 hidden behind a raw 100 — and anything
//     below TWIN_HIDE_FLOOR can be hidden outright. What the guard does buy is
//     that concealment requires publishing a roughly truthful number, so the
//     displayed value cannot be driven to zero while real air is bad.
// So the residual risk is: at a location whose direct feed has gone dark, an
// impostor can understate by up to ~3x, or conceal a below-floor reading
// entirely. Weighed against a daily, visible, wrong number sitting on top of
// the right one, that is the better trade — but it IS a trade, and the second
// bullet is a real hole, recorded here rather than glossed.
// Refuse a suppression that would hide a materially WORSE relay reading.
// One-way on purpose: showing two pins is untidy, hiding pollution is the
// failure this site exists to prevent. Legitimate twins disagree — OpenAQ
// relays the RAW figure while we publish the humidity-corrected one, and its
// hourly republishing lags a fast-moving plume, so the two are often reading
// air up to ~3.5 h apart. Measured over the ten live pairs the direct feed
// runs 44.7%-124% of its relay; the worst case (Sogil Brew, raw 30.2 vs 67.5
// = 2.24x) is a timing offset, not sensor disagreement. So 3x leaves only
// ~1.34x of headroom over observed normal behaviour — thinner than is
// comfortable, and worth re-measuring if legitimate pairs start tripping it.
// The floor keeps the rule from firing on clean-air noise where a ratio
// between two small numbers means nothing.
// The guard deliberately fires even when the relay reading is STALE: a frozen
// high number next to a suspiciously low direct pin still earns its muted
// marker on the map (excluded from every stat, so it costs nothing), and
// review showed relays sit stale ~42% of the time on some stations — a guard
// that switched off with them would be off exactly when an impostor would
// strike.
const TWIN_HIDE_RATIO = 3;
const TWIN_HIDE_FLOOR = 35;
function isAirGradientRelay(s) {
  return !!s && s.source === 'OpenAQ' &&
    /airgradient/i.test(String(s.type || ''));
}
// AirGradient location ids are integers issued in ascending order, so the
// lowest is the longest-established unit at a site — and an impostor cannot
// choose a lower one than a device that was registered years earlier. Compared
// numerically, not as strings, matching devNum() elsewhere in this file: once
// ids pass 1,000,000 every 'ag-10…' sorts below every existing 'ag-19…' as a
// string, which would hand the tiebreak to exactly the newest units.
function agIdNum(id) {
  const n = Number.parseInt(String(id).slice(3), 10);
  return Number.isFinite(n) ? n : Infinity;
}
// oq id → its ag twin, for every relay pair present in `stations`.
function pairAirGradientRelays(stations) {
  const pairs = new Map();
  const ag = stations.filter(s =>
    s && s.source === 'AirGradient' && !s.off &&
    Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!ag.length) return pairs;
  for (const s of stations) {
    if (!isAirGradientRelay(s) || s.off) continue;
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    // Deterministic when a site runs two units at one coordinate: closest
    // first, then the LOWEST NUMERIC id. Name is deliberately NOT consulted.
    // It used to be the first test, which review showed handed the whole
    // tiebreak to an attacker: the AirGradient name is free text on a keyless
    // feed (see fetchAirGradient), so an impostor copying the relay's name beat
    // a genuine unit whose name had drifted even slightly — and `scClean`
    // truncates at 80 chars and strips punctuation, so drift happens on its
    // own. Winning the pairing lets the impostor's raw value, not the genuine
    // unit's, become the reference the anti-burying guard is measured against.
    // Ids are issued in ascending order and cannot be chosen, so ordering on id
    // alone means the longer-established device always wins. Cost is a rare
    // mis-pick between two genuine units sharing one coordinate — both
    // AirGradient, both corrected, so the harm is nil.
    let best = null;
    for (const a of ag) {
      const d = metresBetween(s.lat, s.lon, a.lat, a.lon);
      if (d > TWIN_M) continue;
      if (!best) { best = { a, d }; continue; }
      if (d !== best.d) { if (d < best.d) best = { a, d }; continue; }
      if (agIdNum(a.id) < agIdNum(best.a.id)) best = { a, d };
    }
    if (best) pairs.set(s.id, best.a.id);
  }
  return pairs;
}
// Collapse each discovered pair to the direct AirGradient pin, whether that pin
// is fresh or stale — a stale pin renders muted ("STALE") and is excluded from
// every published figure, which is the honest state for a paused sensor. The
// relay's number is never swapped in for it. Two exceptions, both erring toward
// showing MORE, never less:
//   • a blank AirGradient pin (no reading at all — fastPathFromD1 has no
//     `pm25 IS NOT NULL` filter) never buries a live OpenAQ value: the relay is
//     kept instead, since an empty pin standing in front of a reading serves
//     nobody;
//   • the anti-burying guard above: a relay reading materially worse than the
//     direct feed's raw figure keeps both pins on the map, fresh or stale.
function dropOpenAQNearAirGradient(stations) {
  const pairs = pairAirGradientRelays(stations);
  if (!pairs.size) return stations;
  const byId = new Map();
  for (const s of stations) {
    if (!s || s.id == null) continue;
    // Never collapse two rows onto one key: a duplicated id in an upstream feed
    // would otherwise let a single drop decision remove BOTH copies.
    if (byId.has(s.id)) { byId.set(s.id, null); continue; }
    byId.set(s.id, s);
  }
  // OpenAQ republishes the sensor's raw figure, so compare like with like.
  const rawOf = (s) => Number.isFinite(s && s.pm25_raw) ? s.pm25_raw
                     : (Number.isFinite(s && s.pm25) ? s.pm25 : null);
  const drop = new Set();
  for (const [oqId, agId] of pairs) {
    const oq = byId.get(oqId), ag = byId.get(agId);
    if (!oq || !ag) continue;
    // A pin with no visible reading must never bury one that has one — keyed
    // on pm25, the field the visitor actually sees, not the raw audit field.
    if (!Number.isFinite(ag.pm25) && Number.isFinite(oq.pm25)) { drop.add(agId); continue; }
    // Anti-burying guard — see TWIN_HIDE_RATIO/FLOOR. Fires in every state:
    // fresh-vs-fresh (the impostor case), stale direct pin (live much-worse
    // air must not hide behind a quiet sensor's muted marker), and stale relay
    // (a frozen high number still earns its marker — see the constant's note).
    const agRaw = rawOf(ag);
    if (Number.isFinite(oq.pm25) && oq.pm25 >= TWIN_HIDE_FLOOR &&
        Number.isFinite(agRaw) && agRaw * TWIN_HIDE_RATIO < oq.pm25) {
      // Show both, decide nothing — and TELL THE FRONTEND, because "both" at
      // 0.000000 m means one marker painted exactly on top of the other. The
      // relay is the smaller pin when stale (38 px inside a 42-58 px disc), so
      // without an offset the guard would fire, produce a DOM node nobody can
      // see or click, and the pollution it exists to surface would stay hidden
      // just the same. The frontend draws a flagged pin beside its twin.
      oq.twinConflict = true;
      continue;
    }
    drop.add(oqId);
  }
  return drop.size ? stations.filter(s => !(s && drop.has(s.id))) : stations;
}

async function fetchOpenAQ(env) {
  // 6 search centers, parallel discovery, then parallel detail per station.
  // De-dup by id.
  const centers = [
    {lat:-8.16, lon:115.10},
    {lat:-8.50, lon:115.26},
    {lat:-8.65, lon:115.22},
    {lat:-8.80, lon:115.14},
    {lat:-8.35, lon:114.65},
    {lat:-8.45, lon:115.65},
  ];
  const headers = { Accept: 'application/json', 'X-API-Key': env.OPENAQ_API_KEY };
  const centerHits = await Promise.all(centers.map(async (c) => {
    try {
      const r = await fetch(
        `https://api.openaq.org/v3/locations?coordinates=${c.lat},${c.lon}&radius=25000&limit=20`,
        { headers, cf: { cacheTtl: 1800, cacheEverything: true } }
      );
      const d = await r.json();
      return d.results || [];
    } catch { return []; }
  }));
  const seen = new Set();
  const unique = [];
  for (const list of centerHits) {
    for (const loc of list) {
      if (seen.has(loc.id)) continue;
      seen.add(loc.id);
      unique.push(loc);
    }
  }
  const latest = await Promise.all(unique.map(async (loc) => {
    try {
      const lr = await fetch(`https://api.openaq.org/v3/locations/${loc.id}/latest`, {
        headers, cf: { cacheTtl: 1800, cacheEverything: true }
      });
      const ld = await lr.json();
      return { loc, ld };
    } catch { return { loc, ld: null }; }
  }));
  const out = [];
  for (const { loc, ld } of latest) {
    if (!ld) continue;
    // Match PM2.5 readings robustly across BOTH OpenAQ /latest response shapes:
    //   (a) legacy: each result embeds r.parameter.name === "pm25"
    //   (b) v3:     results carry only { sensorsId, value, datetime }; the
    //               parameter↔sensor mapping lives on loc.sensors[] from the
    //               /locations discovery call.
    // The previous code only read r.parameter.name. If OpenAQ has moved to
    // shape (b) that field is undefined → pm25 stayed null → the 30-day filter
    // dropped every sensor (hypothesis for the OpenAQ=0 outage — NOT yet
    // confirmed against the live key). Honouring both shapes is strictly safer.
    const pm25SensorIds = new Set(
      (loc.sensors || [])
        .filter(s => {
          // Confirmed v3 sensor shape: { id, name:"pm25 µg/m³", parameter:{ name:"pm25", displayName:"PM2.5" } }.
          // Check parameter.name first, then fall back to the sensor's own name.
          const pn = (s.parameter?.name || s.name || '').toString().toLowerCase();
          return pn === 'pm25' || pn.startsWith('pm25') || pn.includes('pm2.5');
        })
        .map(s => s.id)
    );
    // Pick the PM2.5 reading with the NEWEST timestamp, not the last one in
    // array order. OpenAQ's docs warn that a /latest "result" is the last value
    // in the stored series, and that upstream providers may ingest measurements
    // out of time order — so iterating and overwriting would keep whatever
    // happened to come last in the array, which is not necessarily the most
    // recent reading. We compare datetime (utc) and keep the max.
    let pm25=null, lastSeen=null, bestMs=-Infinity;
    for (const r of (ld.results||[])) {
      const pn = (r.parameter?.name || '').toString().toLowerCase();
      const isPm25 = (pn.includes('pm25') || pn.includes('pm2'))                  // shape (a)
                  || (pm25SensorIds.size > 0 && pm25SensorIds.has(r.sensorsId));  // shape (b)
      if (!isPm25) continue;
      // Require a FINITE numeric value. r.value can be null/undefined, an empty
      // string ("" coerces to 0 — that's "no data", not zero pollution), or a
      // non-numeric string ("n/a" → NaN). Reject all of those; otherwise a
      // value-less reading would survive and draw a blank/zero pin.
      const val = (r.value == null || r.value === '') ? NaN : +r.value;
      if (!Number.isFinite(val)) continue;
      const tsRaw = r.datetime?.utc || r.datetime?.local || null;
      const ms = tsRaw ? Date.parse(tsRaw) : NaN;
      // Keep the reading with the newest valid timestamp. If a reading has no
      // parseable timestamp, only accept it when we have nothing else yet.
      if (Number.isFinite(ms)) {
        if (ms <= bestMs) continue;
        bestMs = ms;
      } else if (bestMs > -Infinity) {
        continue;
      }
      pm25 = +val.toFixed(1);
      lastSeen = r.datetime?.local || r.datetime?.utc || null;
    }
    if (!lastSeen || (Date.now() - new Date(lastSeen).getTime()) > 30*24*60*60*1000) continue;
    const { cat, cls } = pm25Category(pm25);
    out.push({
      id: `oq-${loc.id}`,
      name: loc.name || `OpenAQ #${loc.id}`,
      source: 'OpenAQ',
      type: `${loc.provider?.name || '?'} sensor`,
      lat: loc.coordinates?.latitude,
      lon: loc.coordinates?.longitude,
      pm25, aqi: null,
      category: cat, cls,
      lastSeen,
      stale: !isRecent(lastSeen),
    });
  }
  return out;
}

async function fetchIQAir(env) {
  // 7 nearest_city probes — were sequential with 1.2s sleeps (8.4s total).
  // Now PARALLEL. Free tier is 10 req/min so 7-in-parallel-then-done is OK.
  // 429s are caught per-call.
  // IQAir audit (May 2026): of the 7 nearest_city probes we used to run, only
  // ONE backs a real ground sensor. Verified against each IQAir city page's
  // "Data attribution":
  //   • Ubud      → real station "Kopernik" (anonymous contributor)   ← KEEP
  //   • Jimbaran  → real, but it's the SAME unit as PurpleAir "Jimbaran by
  //                 Lumi Clinic", which we already pull natively         ← drop
  //   • Seminyak town, Dajan Tangluk, Banjar, Subagan, Munduk
  //                 → "satellite-derived model" estimates, NOT sensors  ← drop
  // The 5 satellite nodes + Jimbaran are removed so the map only shows real,
  // hyper-local ground data. Their existing D1 rows are left untouched (dormant).
  //
  // nearest_city returns the town CENTROID, not the sensor location — for Ubud
  // that is ~6 km from the real Kopernik device — so we override to the true
  // coordinates and name. The id uses a STABLE per-probe slug ('kopernik')
  // instead of the city name, so an upstream city-name change can't orphan
  // history; existing D1 history was migrated iq-Ubud → iq-kopernik (#27).
  const iqLocs = [
    { label:'Ubud', lat:-8.50, lon:115.26,
      expectCity:'Ubud', slug:'kopernik',
      override:{ name:'Kopernik (Mas, Ubud)', lat:-8.554004068111293, lon:115.27271248947794 } },
  ];
  const probes = await Promise.all(iqLocs.map(async (loc) => {
    try {
      const r = await fetch(
        `https://api.airvisual.com/v2/nearest_city?lat=${loc.lat}&lon=${loc.lon}&key=${env.IQAIR_API_KEY}`,
        { cf: { cacheTtl: 3600, cacheEverything: true } }
      );
      if (r.status === 429) return null;
      const d = await r.json();
      return d.status === 'success' ? { loc, d } : null;
    } catch { return null; }
  }));
  const seen = new Set();
  const out = [];
  for (const probe of probes) {
    if (!probe) continue;
    const { loc, d } = probe;
    const dd = d.data;
    // Guard: nearest_city can return a neighbouring town under load; never
    // emit it under this probe's stable slug if the city doesn't match.
    if (loc.expectCity && dd.city !== loc.expectCity) continue;
    const aqi = dd.current?.pollution?.aqius;
    const mp = dd.current?.pollution?.mainus;
    const pm25Est = mp === 'p2' ? aqiToPm25(aqi) : null;
    const { cat, cls } = pm25Category(pm25Est != null ? pm25Est : aqiToPm25(aqi));
    const dk = `iq-${loc.slug || dd.city}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({
      id: dk,
      name: loc.override?.name || `${loc.label} (${dd.city})`,
      source: 'IQAir',
      type: 'Private sensor',
      // nearest_city returns the town centroid; override to the true device
      // location when known (Kopernik) so the map pin matches reality + D1.
      lat: (loc.override?.lat != null) ? loc.override.lat : dd.location?.coordinates?.[1],
      lon: (loc.override?.lon != null) ? loc.override.lon : dd.location?.coordinates?.[0],
      pm25: pm25Est,
      pm25_estimated: mp === 'p2',
      aqi,
      category: cat,
      cls,
      lastSeen: dd.current?.pollution?.ts || null,
    });
  }
  return out;
}

// ── ENTRYPOINT ────────────────────────────────────────────────────────
export async function onRequest(context) {
  const env = context.env;
  const url = new URL(context.request.url);
  const noFast = url.searchParams.get('fresh') === '1';

  // 1. D1 FAST PATH — sub-200 ms response from cached snapshots.
  // ?fresh=1 bypasses the fast path (useful for diagnostics).
  if (env.ARCHIVE_DB && !noFast) {
    try {
      const fast = await fastPathFromD1(env.ARCHIVE_DB);
      if (fast) {
        // Fold in scraped IQAir stations (their own D1 tables, hourly cadence).
        // Pass the base list so co-located duplicates are dropped.
        try {
          const scraped = await scrapedIQAirFromD1(env.ARCHIVE_DB, fast.stations);
          if (scraped.length) {
            fast.stations.push(...scraped);
            fast.sources = new Set(fast.stations.map(s => s.source)).size;
          }
        } catch (_) { /* scraped optional; serve base fast path */ }
        // Collapse co-located Airly (Nafas-sponsored) onto its live Nafas twin.
        fast.stations = dropAirlyNearNafas(fast.stations);
        // Collapse OpenAQ-relayed AirGradient units onto their direct feed
        // (fresher, 15-min, un-aggregated, and the one we humidity-correct).
        // AG-only: if AirGradient goes quiet the pin shows muted STALE rather
        // than borrowing the relay's uncorrected number; the relay returns on
        // its own only if the AG unit leaves the feed entirely (no pair forms).
        fast.stations = dropOpenAQNearAirGradient(fast.stations);
        // Fold in Smart Citizen OFFLINE tombstones (off:true) — dead or
        // indoor-retagged units keep a grey pin + reachable history. Added
        // after the live folds so live pins act as the de-dup anchors.
        try {
          const tomb = await scOfflineFromD1(env.ARCHIVE_DB, fast.stations);
          if (tomb.length) fast.stations.push(...tomb);
        } catch (_) { /* tombstones optional */ }
        // Source count reflects LIVE feeds only — tombstones aren't a source.
        fast.sources = new Set(fast.stations.filter(s => !s.off).map(s => s.source)).size;
        return jsonResponse(fast);
      }
    } catch (e) {
      // Fall through to upstream
    }
  }

  // 2. UPSTREAM PARALLEL FALLBACK — runs all 6 sources concurrently.
  const sourceFetchers = [
    ['PurpleAir', () => fetchPurpleAir(env)],
    ['AQICN',     () => fetchAQICN(env)],
    ['Airly',     () => fetchAirly(env)],
    ['Nafas',     () => fetchNafas()],
    ['OpenAQ',    () => fetchOpenAQ(env)],
    ['IQAir',     () => fetchIQAir(env)],
  ];
  const settled = await Promise.allSettled(sourceFetchers.map(([_, fn]) => fn()));
  const results = { ts: new Date().toISOString(), sources: 0, stations: [], errors: [] };
  settled.forEach((r, i) => {
    const [name] = sourceFetchers[i];
    if (r.status === 'fulfilled') {
      const stns = r.value || [];
      if (stns.length > 0) {
        results.sources++;
        // Apply stale flag to every station the slow path returns
        results.stations.push(...stns.map(flagStale));
      }
    } else {
      results.errors.push({ source: name, error: String(r.reason).slice(0, 200) });
    }
  });
  // Fold in Smart Citizen (smartcitizen.me public API — OUTDOOR only). Done
  // here, not via sourceFetchers, so the 300 m cross-source de-dup runs against
  // the already-assembled base list. The 15-min worker calls /api/live?fresh=1,
  // sees this de-duped result, and archives SC into the universal tables — so
  // history charts work automatically with no extra worker or table changes.
  try {
    const sc = await fetchSmartCitizen();
    const scKept = dedupSmartCitizen(sc, results.stations);
    if (scKept.length) {
      results.sources++;
      results.stations.push(...scKept.map(flagStale));
    }
  } catch (_) { /* Smart Citizen optional — never block the response */ }

  // Fold in AirGradient (direct public feed — see fetchAirGradient). After the
  // base sources + SC so the 300 m de-dup defers to every established pin;
  // before the scraped-IQAir fold and tombstones, which both de-dup against
  // the full list including AG. The 15-min worker archives AG stations via
  // the universal pass, which also carries them into the D1 fast path.
  try {
    const ag = await fetchAirGradient();
    const agKept = dedupAirGradient(ag, results.stations);
    if (agKept.length) {
      results.sources++;
      results.stations.push(...agKept.map(flagStale));
    }
  } catch (_) { /* AirGradient optional — never block the response */ }

  // Fold in scraped IQAir stations (from D1; the upstream fetchers above do not
  // include them — the iqair-scrape worker is what populates iq_scrape_*).
  if (env.ARCHIVE_DB) {
    try {
      const scraped = await scrapedIQAirFromD1(env.ARCHIVE_DB, results.stations);
      if (scraped.length) {
        results.stations.push(...scraped);
      }
    } catch (_) { /* scraped optional */ }
    // Community-contributed sensors (cs-*). Pushed, not polled, so none of the
    // upstream fetchers above can see them — folded in from D1. The archive
    // worker reads this path (?fresh=1) and skips cs-* when snapshotting, so
    // these are never written back on top of the rows /api/ingest just wrote.
    try {
      const contrib = await contribFromD1(env.ARCHIVE_DB, results.stations);
      if (contrib.length) results.stations.push(...contrib);
    } catch (_) { /* contributed optional */ }
    // Smart Citizen OFFLINE tombstones (see scOfflineFromD1) — folded LAST so
    // every live pin (including scraped IQAir) is already in the base list and
    // a tombstone can never act as a de-dup anchor against a live station.
    // The archive worker reads this path (?fresh=1) and skips off:true
    // stations, so tombstones are never re-snapshotted into D1.
    try {
      const tomb = await scOfflineFromD1(env.ARCHIVE_DB, results.stations);
      if (tomb.length) results.stations.push(...tomb);
    } catch (_) { /* tombstones optional */ }
    // Source count reflects LIVE feeds only — tombstones aren't a source.
    results.sources = new Set(results.stations.filter(s => !s.off).map(s => s.source)).size;
  }
  // Same display folds the fast path applies, so a visitor sees ONE pin per
  // physical device whichever path served them. Gated on !noFast because the
  // archive worker is the only caller that passes ?fresh=1, and it must keep
  // receiving every station — including both halves of a relay pair — or the
  // suppressed half stops being archived under its own id. Outside the
  // ARCHIVE_DB block on purpose: neither fold touches the database, so both
  // still run for a visitor served the slow path with no binding present.
  if (!noFast) {
    results.stations = dropAirlyNearNafas(results.stations);
    results.stations = dropOpenAQNearAirGradient(results.stations);
    results.sources = new Set(results.stations.filter(s => !s.off).map(s => s.source)).size;
  }
  if (results.errors.length === 0) delete results.errors;
  return jsonResponse(results);
}
