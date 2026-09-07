/**
 * /api/hotspots — server-side proxy to NASA FIRMS active fire detections.
 *
 * WHY THIS SOURCE EXISTS, AND WHAT IT DOES NOT DO
 *
 * Every other network in this project measures PM2.5 — the smoke. Methodology
 * §9.2 states the resulting limitation plainly: "We cannot attribute a reading
 * to a source." A PM2.5 sensor weighs smoke; it cannot tell burning plastic
 * from agricultural residue from vehicle exhaust.
 *
 * FIRMS is a *partial* answer to that. It is a thermal observation, not a
 * particulate one: polar-orbiting satellites detect the heat signature of an
 * active fire. So it is independent evidence that something was burning, at a
 * place and a time, which can be read alongside a PM2.5 excursion.
 *
 * It does NOT close §9.2, and this file should not be cited as though it does:
 *
 *   1. DETECTION FLOOR. VIIRS resolves at 375 m. It reliably detects landfill
 *      and agricultural fires — a TPA Suwung fire shows clearly. It does NOT
 *      detect household backyard burning, which is small, brief, and often
 *      under tree cover. A quiet hotspot map on a bad air day means the burns
 *      were small, NOT that nobody was burning. Any UI showing this layer must
 *      say so, or it will be read backwards.
 *
 *   2. OVERPASS GAPS. These are polar orbiters, not geostationary. A fire that
 *      starts and finishes between overpasses is never seen at all. Absence of
 *      a detection is not absence of a fire — the same honest-gap principle
 *      applied to the sensor networks applies here, more strongly.
 *
 *   3. CLOUD. Thermal detection is degraded or blocked by cloud cover, which
 *      in Bali is neither rare nor randomly distributed across the year.
 *
 *   4. NOT ONLY WASTE. A detection is a hot thing, not a waste fire. Cooking
 *      fires, cremation ceremonies, land clearing and industrial heat sources
 *      can all trigger one.
 *
 * Taken together: this layer is good evidence that a fire WAS there, and very
 * weak evidence that one was NOT.
 *
 * PRIVACY / SECURITY PURPOSE (same rationale as /api/wind)
 *
 * Visitors never contact NASA directly, so no visitor IP, referrer or
 * user-agent leaks upstream. The client takes no query parameters: the bbox is
 * hardcoded to Bali and the day range is clamped, so a hostile client cannot
 * use this endpoint to proxy arbitrary fetches or to burn the project's FIRMS
 * transaction quota.
 *
 * DEGRADES, NEVER BLOCKS
 *
 * With no FIRMS_MAP_KEY configured, or on any upstream failure, this returns
 * 200 with an empty `hotspots` array and an `available: false` flag, so a
 * frontend can render the rest of the map unaffected. Consistent with the
 * project rule that a missing key drops a source out rather than breaking the
 * response.
 */

// Same Bali bounding box as the sensor networks (live.js: latMin -9.2,
// latMax -8.0, lonMin 114.4, lonMax 115.8). FIRMS wants west,south,east,north.
const BALI_BBOX = '114.4,-9.2,115.8,-8.0';

// VIIRS at 375 m. Three satellites are queried because each adds overpasses,
// and overpass count is the binding constraint on whether a short fire is seen
// at all. MODIS is deliberately not queried: at 1 km it is coarser than the
// fires this project cares about, and it would add duplicate detections of the
// large ones without revealing any small ones.
const FIRMS_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

// FIRMS accepts 1-5 ONLY. A 10-day request is answered "Invalid day range.
// Expects [1..5]." with HTTP 200 (measured 2026-09-07) -- see the non-CSV
// guard below, which is what stops that string being parsed as zero fires.
//
// 5 rather than a shorter window because Bali is genuinely sparse in this
// dataset: a live query for the Bali bbox returned ZERO detections, while the
// same query widened to Java/Sumatra/Kalimantan returned 762 in three days.
// At 375 m the fires here mostly are not visible, so a narrow window would
// show an empty layer nearly always and the occasional real landfill fire --
// the event this source exists to catch -- could fall outside it.
const DAY_RANGE = 5;

const UPSTREAM_TIMEOUT_MS = 8000;   // matches the 8s upstream timeout in live.js
const CACHE_TTL_S = 900;            // 15 min; NRT latency is ~60 min, so polling faster gains nothing

/**
 * Parses a FIRMS CSV response.
 *
 * Deliberately tolerant of column order: FIRMS has added columns before, and
 * positional parsing would silently mis-assign every field when it happens.
 * Rows missing a usable lat/lon are dropped rather than defaulted — a hotspot
 * at 0,0 is worse than no hotspot.
 */
function parseFirmsCsv(text, source) {
  const lines = String(text || '').trim().split('\n');
  if (lines.length < 2) return [];

  const cols = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const at = (name) => cols.indexOf(name);

  const iLat = at('latitude');
  const iLon = at('longitude');
  const iDate = at('acq_date');
  const iTime = at('acq_time');
  const iConf = at('confidence');
  const iBright = at('bright_ti4');
  const iFrp = at('frp');
  const iDayNight = at('daynight');

  if (iLat === -1 || iLon === -1) return [];

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const lat = parseFloat(f[iLat]);
    const lon = parseFloat(f[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // Second filter, in our own bbox terms. FIRMS honours the bbox, but this
    // is the same defensive check live.js applies to AQICN after that API
    // returned a station in Oregon.
    if (lat < -9.2 || lat > -8.0 || lon < 114.4 || lon > 115.8) continue;

    // acq_time is HHMM in UTC, zero-padded inconsistently across sources.
    let observedAt = null;
    if (iDate !== -1 && f[iDate]) {
      const hhmm = String(iTime !== -1 ? (f[iTime] || '0') : '0').padStart(4, '0');
      const iso = `${f[iDate].trim()}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) observedAt = new Date(ms).toISOString();
    }

    out.push({
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      observedAt,                                             // ISO 8601 UTC, or null
      confidence: iConf !== -1 ? (f[iConf] || '').trim() : '', // VIIRS: 'l' | 'n' | 'h'
      brightnessK: iBright !== -1 ? parseFloat(f[iBright]) || null : null,
      frpMw: iFrp !== -1 ? parseFloat(f[iFrp]) || null : null, // fire radiative power
      dayNight: iDayNight !== -1 ? (f[iDayNight] || '').trim() : '',
      satellite: source,
    });
  }
  return out;
}

/**
 * De-duplicates detections of the same fire seen by more than one satellite.
 *
 * Two detections within ~500 m and 30 minutes of each other are treated as one
 * fire. 500 m is a little over one VIIRS pixel, so this collapses genuine
 * double-observations without merging two neighbouring fires into one. The
 * detection kept is the one with the highest fire radiative power, since that
 * is the observation that saw the fire most fully.
 */
function dedupe(rows) {
  const kept = [];
  for (const r of rows) {
    const dup = kept.find((k) => {
      if (Math.abs(k.lat - r.lat) > 0.005 || Math.abs(k.lon - r.lon) > 0.005) return false;
      if (!k.observedAt || !r.observedAt) return true;
      return Math.abs(Date.parse(k.observedAt) - Date.parse(r.observedAt)) < 30 * 60 * 1000;
    });
    if (!dup) {
      kept.push(r);
      continue;
    }
    if ((r.frpMw || 0) > (dup.frpMw || 0)) Object.assign(dup, r);
  }
  return kept;
}

function json(body, status, cacheable) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheable
        ? `public, max-age=${CACHE_TTL_S}, s-maxage=${CACHE_TTL_S}`
        : 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // No ACAO header, for the reason documented at length in api/wind.js.
    },
  });
}

export async function onRequestGet({ env }) {
  // No key configured is a normal state, not an error: the source drops out
  // and the rest of the map is unaffected.
  if (!env.FIRMS_MAP_KEY) {
    return json({ available: false, reason: 'not_configured', dayRange: DAY_RANGE, hotspots: [] }, 200, false);
  }

  const settled = await Promise.allSettled(
    FIRMS_SOURCES.map(async (source) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_MAP_KEY}`
        + `/${source}/${BALI_BBOX}/${DAY_RANGE}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        cf: { cacheTtl: CACHE_TTL_S, cacheEverything: true },
      });
      if (!res.ok) throw new Error(`${source} ${res.status}`);
      const text = await res.text();
      // NOT defensive speculation -- FIRMS really does return plain-text
      // errors under HTTP 200. Measured 2026-09-07: an out-of-range day count
      // returns 200 with "Invalid day range. Expects [1..5]." (a bad *key*, by
      // contrast, returns 400, which res.ok already catches).
      //
      // Without this check that body parses as a CSV with no data rows, i.e.
      // as "no fires in Bali" -- which is both plausible-looking here and
      // completely wrong. An upstream error must never be presented as an
      // empty sky.
      if (!/latitude/i.test(text.split('\n')[0] || '')) throw new Error(`${source} non_csv`);
      return parseFirmsCsv(text, source);
    })
  );

  const rows = [];
  const succeeded = [];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      rows.push(...settled[i].value);
      succeeded.push(FIRMS_SOURCES[i]);
    }
  }

  // Every satellite failing is a source outage, not an empty sky. Saying
  // "available: false" keeps that distinct from a genuine zero — the honest
  // gap rule. A frontend must not render these two states identically.
  if (!succeeded.length) {
    return json({ available: false, reason: 'upstream_failed', dayRange: DAY_RANGE, hotspots: [] }, 200, false);
  }

  const hotspots = dedupe(rows).sort((a, b) =>
    String(b.observedAt || '').localeCompare(String(a.observedAt || ''))
  );

  return json({
    available: true,
    dayRange: DAY_RANGE,
    satellites: succeeded,
    // Carried in the payload so a consumer cannot present this layer as a
    // complete record of burning without having been told otherwise.
    resolutionM: 375,
    detectionFloorNote:
      'VIIRS resolves at 375 m. Landfill and agricultural fires are detected; '
      + 'household backyard burning generally is not. Absence of a detection is '
      + 'not evidence that nothing was burning.',
    attribution: 'NASA FIRMS (LANCE/ESDIS)',
    count: hotspots.length,
    hotspots,
  }, 200, true);
}
