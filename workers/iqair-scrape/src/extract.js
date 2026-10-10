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

// ── One device, or a town value? ─────────────────────────────────────────
// Every station we publish is one physical device (DATA-METHODOLOGY §8.5).
// IQAir renders station pages and city/state pages from one template, so a
// page has to prove which it is. The attribution line alone is not proof: a
// city with a single station reads "1 station from <contributor>", one
// character from a station page's "Station from <contributor>". Verified on
// IQAir's Bali pages, 10 Oct 2026, raw and rendered:
//   station page   "Station from <contributor>" (no count), and exactly one
//                  /air-quality-map?lat=..&lng=.. link — the device's own spot
//   city / state   "<N> station(s) from <…>" (Bali 33, Badung 7, Nusa Dua 1)
//                  and no map link at all
// A relayed device additionally carries "Data sources: <network> via <…>"
// (e.g. "AirGradient via OpenAQ") — a station, but someone else's data.
const GAP = '(?:\\s|&nbsp;|&#160;|<!--\\s*-->)+';
const GAP0 = '(?:\\s|&nbsp;|&#160;|<!--\\s*-->)*';
// Both markers are tied to the attribution line's own structure — the text is
// followed directly by the contributor <span> — so a device NAMED "1 station
// from home" in some list elsewhere on the page cannot trip either of them.
const AGGREGATE_RE = new RegExp('>\\s*\\d+' + GAP + 'stations?' + GAP + 'from' + GAP0 + '<span\\b', 'i');
// Case-sensitive on purpose: capital S with nothing counted in front of it.
const STATION_RE = new RegExp('>\\s*Station' + GAP + 'from' + GAP0 + '<span\\b');
const CONTRIBUTOR_RE = new RegExp('>\\s*Station' + GAP + 'from' + GAP0 + '<span[^>]*>([^<]{1,160})</span>');
const MAP_LINK_RE = /air-quality-map\?lat=(-?\d{1,3}(?:\.\d+)?)(?:&amp;|&#38;|&)lng=(-?\d{1,3}(?:\.\d+)?)/g;
// The label alone decides relay-or-not; the names after it are only for the
// log, so a longer block or a reworded tail can never make a relay look native.
const DATA_SOURCES_LABEL_RE = new RegExp('Data sources?' + GAP0 + ':', 'i');
const DATA_SOURCES_RE = new RegExp('Data sources?' + GAP0 + ':([\\s\\S]{0,4000}?)</p>', 'i');

// The single position the page's map card points at, or null if there is no
// such link or more than one distinct position (then we cannot tell which is
// this station's). Raw HTML carries lat/lng only; the hydrated page adds a
// placeId — both match.
function mapLinkCoords(html) {
  if (typeof html !== 'string') return null;
  const seen = new Map();
  for (const m of html.matchAll(MAP_LINK_RE)) {
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    seen.set(lat + ',' + lon, { lat, lon });
  }
  return seen.size === 1 ? [...seen.values()][0] : null;
}

// 'aggregate' on any positive sign of a town/area value; 'station' only on
// both positive signs of a single device; 'unknown' otherwise (a page we
// already scrape keeps working through a cosmetic redesign — but discovery
// admits nothing that is not 'station').
function pageKind(html) {
  if (typeof html !== 'string') return 'unknown';
  if (AGGREGATE_RE.test(html)) return 'aggregate';
  if (STATION_RE.test(html) && mapLinkCoords(html)) return 'station';
  return 'unknown';
}

// Names of the networks a relayed station's data comes from ("AirGradient",
// "OpenAQ"), or null when IQAir is publishing the contributor's own device.
function dataSources(html) {
  if (typeof html !== 'string' || !DATA_SOURCES_LABEL_RE.test(html)) return null;
  const m = html.match(DATA_SOURCES_RE);
  if (!m) return ['unnamed'];
  const names = [...m[1].matchAll(/<a\b[^>]*>([^<]{1,80})<\/a>/g)]
    .map(x => x[1].trim())
    .filter(n => n && !/^\(?\s*(?:cc[- ]by|licen[sc]ed)/i.test(n));
  return names.length ? names : ['unnamed'];
}

function contributorName(html) {
  const m = typeof html === 'string' ? html.match(CONTRIBUTOR_RE) : null;
  return m ? m[1].replace(/&amp;/g, '&').trim() || null : null;
}

// Fallback for pages IQAir has migrated OFF server-streamed data (no
// `streamController.enqueue` chunks — the reading is only in the rendered DOM
// that Firecrawl serialized). Parses the current PM2.5 / AQI / reading time
// straight out of the HTML. Returns the same shape as extractStation, minus
// history (migrated pages expose only current + forecast). Coordinates come
// from the station's own map link when the page proves it is a station page;
// otherwise they stay null and the ingest COALESCE keeps the catalog's.
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function extractFromDom(html) {
  // Station-page guard: only trust a reading from a real station page. A deleted
  // station (404) or an error page can still render nearby-city / world-AQI
  // widgets carrying a stray µg/m³ figure; ingesting that would resurrect a dead
  // station with an unrelated number. A genuine station page's <title> is
  // "<name> Air Quality Index (AQI)…"; a 404 page's is not. Require it.
  if (!/<title>[^<]*Air Quality/i.test(html)) return null;
  // Never a town value, even if a city URL ends up in the list (§8.5).
  if (pageKind(html) === 'aggregate') return { rejected: 'aggregate_page' };

  // Current PM2.5 tile: "Main pollutant:</p><p>PM2.5</p></div><p>7&nbsp;µg/m³</p>".
  // Anchor to the tile, NOT the first µg/m³ on the page: a WHO-comparison blurb
  // ("…guideline of 5 µg/m³…") elsewhere must never win. Primary anchor = the
  // "Main pollutant" label just above the value; fallback = a value that is the
  // ENTIRE content of its own <p> (">7&nbsp;µg/m³</p>"), which prose figures are
  // not.
  let conc = null;
  const mc = html.match(/Main pollutant[\s\S]{0,220}?>([\d.]+)(?:&nbsp;|&#160;|\s)*µg\/m³<\/p>/i)
          || html.match(/>([\d.]+)(?:&nbsp;|&#160;|\s)*µg\/m³<\/p>/);
  if (mc) { const v = parseFloat(mc[1]); if (Number.isFinite(v) && v >= 0 && v < 2000) conc = v; }
  // Current US AQI: "<p ...>39</p><span ...>US AQI".
  let aqi = null;
  const ma = html.match(/>(\d{1,4})<\/p>\s*<span[^>]*>\s*US AQI/i);
  if (ma) { const v = parseInt(ma[1], 10); if (Number.isFinite(v) && v >= 0 && v <= 1000) aqi = v; }
  // Name from the <title> ("... Air Quality Index").
  let name = null;
  const mn = html.match(/<title>([^<|]+?)\s+Air Quality/i);
  if (mn) name = mn[1].trim();
  // Reading time: "04:00, Jul 21 Local time" (WITA = UTC+8). Build an ISO ts;
  // infer the year, rolling it back or forward if the date lands >2 days off
  // now — the forward case covers the New-Year window when UTC is still Dec but
  // WITA is already Jan (or vice-versa).
  //
  // Layouts tried in order; the first that yields a plausible time wins. Some
  // IQAir pages dropped the "Local time" label by Oct 2026, which left this
  // fallback writing no hourly point at all for them. Every hour is labelled by
  // its START, as the stream labels it, so both paths land on the same row.
  //   "• 21:00, Oct 10[ Local time]"  page header: the END of the hour whose
  //                                   value the page shows, so minus 1 h.
  //   "20:00–21:00 Oct 10"            the history chart's latest hour: its start.
  // Measured 10 Oct 2026 on 7 live stations, two snapshots: header − 1 h was
  // the stream's latest hour, with the same value, in 9 of 10 readings. The
  // tenth (Plataran) had a stream already an hour ahead of its own page. The
  // pre-Oct code took the "Local time" header without the hour shift.
  const tsFrom = (hh, mi, mon, day, shiftH) => {
    if (MONTHS[mon] == null) return null;
    // The page prints no year. Take whichever of last/this/next year puts the
    // reading closest to now (covers the New-Year window both ways), and refuse
    // a time in the future. The old rule moved anything more than two days old
    // into NEXT year, so a dead device's last reading came back dated a year
    // ahead — fresh to every staleness check downstream.
    const now = Date.now();
    const year = new Date(now).getUTCFullYear();
    const at = (y) => Date.UTC(y, MONTHS[mon], +day, +hh + shiftH, +mi) - 8 * 3600 * 1000;
    const ms = [year - 1, year, year + 1].map(at)
      .reduce((best, x) => Math.abs(x - now) < Math.abs(best - now) ? x : best);
    return Number.isFinite(ms) && ms - now <= 2 * 3600 * 1000 ? new Date(ms).toISOString() : null;
  };
  const layouts = [
    [/(?:•|&bull;|&#8226;)\s*(\d{1,2}):(\d{2}),\s*([A-Za-z]{3})\s+(\d{1,2})(?:\s+Local time)?\s*</, -1],
    [/(\d{1,2}):(\d{2})\s*(?:–|-|&ndash;|&#8211;)\s*\d{1,2}:\d{2}(?:\s|&nbsp;|&#160;)+([A-Za-z]{3})(?:\s|&nbsp;|&#160;)+(\d{1,2})\b/, 0],
    [/(\d{1,2}):(\d{2}),\s*([A-Za-z]{3})\s+(\d{1,2})\s+Local time/, -1],
  ];
  let ts = null;
  for (const [re, shiftH] of layouts) {
    const m = html.match(re);
    if (m && (ts = tsFrom(m[1], m[2], m[3], m[4], shiftH))) break;
  }
  if (conc == null && aqi == null) return null;  // genuinely nothing on the page
  // Synthesize one hourly point so the reading accrues into history and carries
  // a timestamp; if the time didn't parse, leave history empty (liveness still
  // works — the scrape succeeds and last_scrape_ts advances).
  const hourly = (conc != null && ts) ? [{ ts, aqi, concentration: conc }] : [];
  const pos = pageKind(html) === 'station' ? mapLinkCoords(html) : null;
  return {
    name, lat: pos ? pos.lat : null, lon: pos ? pos.lon : null,
    currentConcentration: conc, currentAqi: aqi,
    mainPollutant: 'pm25', sourceType: null, sourceSubType: null, contributor: contributorName(html),
    hourly, daily: [], monthly: [],
    counts: { hourly: hourly.length, daily: 0, monthly: 0 },
    domFallback: true,
  };
}

// Main entry. Returns null if the page had no decodable station payload.
function extractStation(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return null;
  const { arr, promiseMap } = buildArray(rawHtml);
  // No SSR stream at all → IQAir migrated this page to client-side data; the
  // reading is only in the rendered DOM. (Staggered rollout: as of 2026-07,
  // lycee/villa-solaris/rock-n-love had flipped while others still streamed.)
  if (!arr.length) return extractFromDom(rawHtml);
  if (pageKind(rawHtml) === 'aggregate') return { rejected: 'aggregate_page' };
  const res = makeResolver(arr, promiseMap);
  let root;
  try { root = res(0); } catch { root = null; }
  const details = root ? findDetails(root) : null;
  // IQAir's own description of the page, when the stream carries it: a station
  // page is type 'station' with one active station (verified on Seminyak Beach
  // - Hotel Indigo). Anything else is an area value, whatever it is called.
  if (details && ((typeof details.type === 'string' && details.type !== 'station') ||
                  (typeof details.activeStationsCount === 'number' && details.activeStationsCount > 1))) {
    return { rejected: 'aggregate_page' };
  }
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
  if ((lat == null || lon == null) && pageKind(rawHtml) === 'station') {
    const pos = mapLinkCoords(rawHtml);
    if (pos) { lat = pos.lat; lon = pos.lon; }
  }
  if (!contributor) contributor = contributorName(rawHtml);
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

  // Stream present but no reading recovered (partial migration / structure
  // shift): fall back to the rendered DOM so the station stays live. Prefer a
  // DOM current value only when the stream gave us nothing.
  if (currentConc == null && !hourly.length) {
    const dom = extractFromDom(rawHtml);
    if (dom && dom.rejected) return dom;
    if (dom) {
      dom.lat = lat != null ? lat : dom.lat;
      dom.lon = lon != null ? lon : dom.lon;
      dom.name = name || dom.name;
      return dom;
    }
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

export { extractStation, extractFromDom, buildArray, makeResolver, follow, findDetails,
         pageKind, mapLinkCoords, dataSources, contributorName };
