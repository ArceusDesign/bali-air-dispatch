// Extract IQAir station data from a Firecrawl-rendered page (rawHtml).
//
// IQAir station pages (https://www.iqair.com/.../<station>) are React-Router v7
// apps. The page streams its loader data via
//   window.__reactRouterContext.streamController.enqueue("<turbo-stream chunk>")
// in one or more <script> tags. The payload is a reference-deduplicated flat
// array (turbo-stream style): every object value is an integer index into the
// concatenated array; object keys are interned as "_<idx>" and may chain
// ("_154" -> arr[154] === "_98" -> arr[98] === "aqi"); negative ints are
// sentinels (undefined/NaN/etc).
//
// This decoder rebuilds the flat array, resolves references, and pulls out the
// station's coordinates, name, current PM2.5, and the historical hourly/daily/
// monthly series ({ ts, aqi, concentration }). NO IQAir API is called — this is
// purely the data the page itself ships. Verified against a live scrape of
// "Lycee Francais De Bali": latest hourly point {ts, aqi:22, concentration:4}
// matches the page's displayed reading (US AQI 22, PM2.5 4 µg/m³).

const REF = /^_(\d+)$/;

// Pull each enqueue("...") string argument out of the HTML, honouring JS
// backslash escapes so we stop at the real closing quote.
function enqueueChunks(html) {
  const chunks = [];
  const marker = 'streamController.enqueue("';
  let from = 0;
  for (;;) {
    const start = html.indexOf(marker, from);
    if (start < 0) break;
    let j = start + marker.length;
    const buf = [];
    while (j < html.length) {
      const c = html[j];
      if (c === '\\') { buf.push(html[j], html[j + 1]); j += 2; continue; }
      if (c === '"') break;
      buf.push(c); j += 1;
    }
    chunks.push(buf.join(''));
    from = j + 1;
  }
  return chunks;
}

// Build the global flat array by decoding + concatenating every chunk.
// Also returns a promiseMap: a chunk prefixed "P<n>:" is the resolution of a
// deferred Promise whose placeholder elsewhere in the stream is ["P", n]. We
// map n -> the array offset where that chunk's root value begins, so the
// resolver can follow ["P", n] into the chunk that carries (e.g.) the
// historical `measurements` block.
function buildArray(html) {
  const arr = [];
  const promiseMap = {};
  for (const raw of enqueueChunks(html)) {
    // raw is the inner content of a JS string literal; decode escapes via JSON.
    let s;
    try { s = JSON.parse('"' + raw + '"'); } catch { continue; }
    if (!s) continue;
    // Optional "<prefix>:" before the JSON array (e.g. "P20:[...]").
    let prefix = '';
    let body = s;
    if (s[0] !== '[' && s[0] !== '{') {
      const k = s.indexOf(':');
      if (k > 0) { prefix = s.slice(0, k); body = s.slice(k + 1); }
    }
    let part;
    try { part = JSON.parse(body); } catch { continue; }
    if (!Array.isArray(part)) continue;
    const offset = arr.length;
    const pm = /^P(\d+)$/.exec(prefix);
    if (pm) promiseMap[pm[1]] = offset;
    for (const el of part) arr.push(el);
  }
  return { arr, promiseMap };
}

// Resolve an interned key like "_154" to its terminal string name.
function follow(arr, s, depth = 0) {
  while (typeof s === 'string' && REF.test(s) && depth < 64) {
    s = arr[parseInt(s.slice(1), 10)];
    depth += 1;
  }
  return s;
}

// Cycle-safe reference resolver. Integers are indices; negatives -> null.
// A value ["P", n] is a deferred-Promise placeholder: resolve it by following
// promiseMap[n] into the chunk that carries the resolved value.
function makeResolver(arr, promiseMap = {}) {
  const cache = new Map();
  const inProgress = new Set();
  function res(idx) {
    if (typeof idx === 'string') {
      const m = REF.exec(idx);
      return m ? res(parseInt(m[1], 10)) : idx;
    }
    if (typeof idx !== 'number') return idx;
    if (idx < 0) return null;
    if (cache.has(idx)) return cache.get(idx);
    if (inProgress.has(idx)) return null;
    inProgress.add(idx);
    const v = arr[idx];
    let out;
    if (Array.isArray(v)) {
      if (v.length === 2 && v[0] === 'P' && typeof v[1] === 'number') {
        const off = promiseMap[String(v[1])];
        out = (off != null) ? res(off) : null;
      } else {
        out = v.map(x => res(x));
      }
    } else if (v && typeof v === 'object') {
      out = {};
      for (const k of Object.keys(v)) {
        const m = REF.exec(k);
        const key = m ? follow(arr, arr[parseInt(m[1], 10)]) : k;
        out[key] = res(v[k]);
      }
    } else if (typeof v === 'string') {
      const m = REF.exec(v);
      out = m ? res(parseInt(m[1], 10)) : v;
    } else {
      out = v;
    }
    inProgress.delete(idx);
    cache.set(idx, out);
    return out;
  }
  return res;
}

// Find the page's "details" node — the station object itself. On IQAir station
// pages this lives at loaderData['routes/$'].details and carries the station's
// identity fields directly: { name, coordinates:{latitude,longitude},
// current:{ts,aqi,concentration,mainPollutant,...}, sources, contributors,... }.
function findDetails(node, seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (seen.has(node)) return null;
  seen.add(node);
  if (typeof node.name === 'string' &&
      node.coordinates && typeof node.coordinates === 'object' &&
      typeof node.coordinates.latitude === 'number' &&
      node.current && typeof node.current === 'object') {
    return node;
  }
  for (const k of Object.keys(node)) {
    const r = findDetails(node[k], seen, depth + 1);
    if (r) return r;
  }
  return null;
}

// Find the historical `measurements` block: an object carrying hourly/daily/
// monthly series, each point shaped { ts, aqi, pm25:{ aqi, concentration } }.
// On IQAir pages this is a deferred Promise resolved via the P<n> chunk, so it
// is only reachable once the resolver follows ["P", n].
function findMeasurements(node, seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 60) return null;
  if (seen.has(node)) return null;
  seen.add(node);
  const looksLikeSeries = (a) =>
    Array.isArray(a) && a.length > 0 && a[0] && typeof a[0] === 'object' && 'ts' in a[0];
  // distinguish measurements (has pm25/concentration) from forecasts
  // (has wind/temperature). Both conditions must hold — note the parens around
  // the hasConcentration group; without them `&&` binds tighter than `||` and
  // a forecasts/other node matches falsely.
  if ((looksLikeSeries(node.hourly) || looksLikeSeries(node.daily) || looksLikeSeries(node.monthly)) &&
      (hasConcentration(node.hourly) || hasConcentration(node.daily) || hasConcentration(node.monthly))) {
    return node;
  }
  for (const k of Object.keys(node)) {
    const r = findMeasurements(node[k], seen, depth + 1);
    if (r) return r;
  }
  return null;
}

function hasConcentration(series) {
  if (!Array.isArray(series) || !series.length) return false;
  const p = series[0];
  if (!p || typeof p !== 'object') return false;
  if (typeof p.concentration === 'number') return true;
  if (p.pm25 && typeof p.pm25 === 'object' && typeof p.pm25.concentration === 'number') return true;
  return false;
}

// Normalise a raw series into [{ ts, aqi, concentration }] ascending by ts.
// Concentration may be top-level or nested under pm25 (IQAir's shape).
function cleanSeries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const ts = p.ts;
    if (typeof ts !== 'string') continue;
    let conc = (typeof p.concentration === 'number') ? p.concentration : null;
    let aqi = (typeof p.aqi === 'number') ? p.aqi : null;
    if (conc == null && p.pm25 && typeof p.pm25 === 'object') {
      if (typeof p.pm25.concentration === 'number') conc = p.pm25.concentration;
      if (aqi == null && typeof p.pm25.aqi === 'number') aqi = p.pm25.aqi;
    }
    if (conc == null && aqi == null) continue;
    // IQAir ships float noise (e.g. 15.9000000953674); round to 1 dp.
    if (conc != null) conc = Math.round(conc * 10) / 10;
    out.push({ ts, aqi, concentration: conc });
  }
  // de-dupe by ts (keep last), sort ascending
  const byTs = new Map();
  for (const p of out) byTs.set(p.ts, p);
  return [...byTs.values()].sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
}

// Main entry. Returns null if the page had no decodable station payload.
function extractStation(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return null;
  const { arr, promiseMap } = buildArray(rawHtml);
  if (!arr.length) return null;
  const res = makeResolver(arr, promiseMap);
  let root;
  try { root = res(0); } catch { root = null; }
  const details = root ? findDetails(root) : null;
  const current = details ? details.current : null;

  // Identity fields live directly on details; current reading on details.current.
  // Fall back to a direct regex on the raw blob for coords.
  let lat = null, lon = null, name = null, currentConc = null, currentAqi = null;
  let sourceType = null, sourceSubType = null, mainPollutant = null;
  let contributor = null;

  if (details) {
    name = details.name || null;
    const c = details.coordinates || {};
    lat = (typeof c.latitude === 'number') ? c.latitude : null;
    lon = (typeof c.longitude === 'number') ? c.longitude : null;
    // sources[0]/contributors[0] describe provenance (Corporate vs Contributor,
    // Education, etc.) — useful to tell a real device from an estimate.
    const src = Array.isArray(details.sources) && details.sources[0];
    const con = Array.isArray(details.contributors) && details.contributors[0];
    if (src) { sourceType = src.type || null; sourceSubType = src.subtype || null; }
    if (con) contributor = con.name || null;
  }
  if (current && typeof current === 'object') {
    mainPollutant = current.mainPollutant || null;
    if (typeof current.concentration === 'number') currentConc = current.concentration;
    if (typeof current.aqi === 'number') currentAqi = current.aqi;
  }

  // Regex fallbacks against the serialized blob.
  if (lat == null || lon == null) {
    const m = rawHtml.match(/"latitude",(-?\d+(?:\.\d+)?),"longitude",(-?\d+(?:\.\d+)?)/);
    if (m) { lat = parseFloat(m[1]); lon = parseFloat(m[2]); }
  }
  if (!name) {
    const m = rawHtml.match(/<title>([^<|]+?)\s+Air Quality/i);
    if (m) name = m[1].trim();
  }

  // Historical PM2.5 series live in a deferred `measurements` block (resolved
  // via a P<n> chunk), separate from `details`. Search the whole resolved tree
  // for the object whose hourly/daily/monthly points carry concentration.
  const hist = (root ? findMeasurements(root) : null) || {};
  const hourly = cleanSeries(hist.hourly);
  const daily = cleanSeries(hist.daily);
  const monthly = cleanSeries(hist.monthly);

  // Current PM2.5: prefer the explicit current reading, else the latest hourly.
  if (currentConc == null && hourly.length) {
    currentConc = hourly[hourly.length - 1].concentration;
  }
  if (currentAqi == null && hourly.length) {
    currentAqi = hourly[hourly.length - 1].aqi;
  }

  return {
    name, lat, lon,
    currentConcentration: currentConc,
    currentAqi,
    mainPollutant, sourceType, sourceSubType, contributor,
    hourly, daily, monthly,
    counts: { hourly: hourly.length, daily: daily.length, monthly: monthly.length },
  };
}

export { extractStation, buildArray, makeResolver, follow, findDetails };
