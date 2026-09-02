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

// ── UPSTREAM TIMEOUT GUARD ────────────────────────────────────────────
// Every upstream fetch in this file goes through here. A module-scope function
// declaration named `fetch` shadows the global for this module, so all call
// sites — and any added later — inherit the timeout without being touched.
//
// Why this exists: this endpoint fans out to 8 independent networks under
// Promise.allSettled, which means the SLOWEST source dictates total time.
// Before this guard there was not a single AbortSignal in the file, so one
// upstream hanging had no bound at all — it held the invocation open until
// Cloudflare killed it, which surfaces to callers as a 503 and (for the
// archive worker's ?fresh=1 call) as a permanently missing archive tick.
// A source that times out is simply absent from this response; that is the
// intended outcome and every call site already tolerates a rejection, either
// via Promise.allSettled or its own try/catch. Honest partial data beats a
// dead endpoint.
const UPSTREAM_TIMEOUT_MS = 8000;
const _rawFetch = globalThis.fetch.bind(globalThis);
function fetch(input, init) {
  // Respect a caller-supplied signal rather than silently replacing it.
  if (init && init.signal) return _rawFetch(input, init);
  return _rawFetch(input, { ...(init || {}), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

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
// observedAtMs (optional) — when WE recorded this reading. A reading cannot be
// fresher than the moment we observed it, so this acts as a floor on the age.
// It matters because `lastSeen` (the upstream "till") is the primary signal and
// some sources do not send one at all: with a NULL till this function used to
// return early and the station rendered as current no matter how old the row
// was. That was harmless while the fast path only ever served rows < 30 min
// old, but the widening ladder in fastPathFromD1 can now serve rows up to 12 h
// old, which would have turned that latent hole into stale readings presented
// as live. Taking the MAX of the two ages keeps the honest-gap principle:
// where the two disagree, believe the older one.
function flagStale(station, observedAtMs) {
  const ms = parseLastSeenMs(station.lastSeen);
  const ages = [];
  if (ms != null) ages.push(Date.now() - ms);
  if (observedAtMs != null) ages.push(Date.now() - observedAtMs);
  if (!ages.length) return station;
  // ?? not ||, so a future 0 ("always stale") cannot silently become 24 h.
  const limit = SOURCE_STALE_MS[station.source] ?? STALE_THRESHOLD_MS;
  const age = Math.max(...ages);
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
// One SQL: every station catalog row joined to its most-recent snapshot.
// The 30-min rung is the normal one (the worker writes every 15 min, so this
// catches every station between cron ticks). If we get ≥ 5 rows back, serve
// immediately.
//
// WIDENING LADDER — this is an outage circuit-breaker, not a nicety.
// Until 2026-08-31 this was a single 30-min window with a hard `return null`
// below 5 rows, and that cliff turned a blip into a 36-hour outage:
//
//   archive worker stalls → after 30 min < 5 stations are fresh → fast path
//   returns null → EVERY visitor request falls through to the full 8-network
//   upstream fan-out → p99 CPU triples (12–27 ms → 51–85 ms, measured) →
//   Cloudflare kills invocations with `exceededResources` → /api/live 503s →
//   the archive worker's own ?fresh=1 call 503s too, so it cannot write the
//   snapshots that would make the fast path cheap again → the loop sustains
//   itself until the platform lets go.
//
// A contributed sensor pushing every 60 s kept exactly ONE station fresh
// throughout, so the table was never empty — just permanently under the
// threshold of 5. Widening instead of falling through breaks the cycle: a
// stalled worker now degrades to older-but-cheap data rather than melting the
// endpoint down. Rows served past the first rung are OLDER, never faked —
// flagStale() below marks each station from its own upstream timestamp, so a
// stale reading renders as stale. The widest rung still failing means D1 is
// genuinely empty (cold start), which is the one case worth paying full price
// for. The archive worker is unaffected either way: it always passes ?fresh=1,
// which bypasses this function entirely.
//
// Single query, widest window — the subquery pins one row per station, so a
// wider window admits more STATIONS, not more rows per station (~65 max).
const FAST_PATH_FRESH_SEC = 30 * 60;
const FAST_PATH_WIDEST_SEC = 12 * 60 * 60;
async function fastPathFromD1(db) {
  const nowSec = Math.floor(Date.now() / 1000);
  // NARROW FIRST, widen only on a shortfall. This ordering is load-bearing and
  // was got wrong once: fetching the widest window every time and filtering in
  // JS looked tidier (one round trip) but drives the plan off idx_ssnap_ts
  // (ts > ?), so the rows SCANNED are every snapshot inside the window, each
  // one paying a correlated MAX(ts) subquery. Measured against real data:
  // 111 rows for 30 min versus 2,034 for 12 h — an 18x read amplification on
  // the single hottest query in the project, which on D1's row-metered pricing
  // is the difference between comfortable and over quota. The healthy path
  // must stay one cheap query; the wide one is an outage measure and only runs
  // when the narrow window has already come up short.
  const runWindow = async (cutoff) => {
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
    return rows.results || [];
  };

  const fresh = await runWindow(nowSec - FAST_PATH_FRESH_SEC);
  let results = fresh, degraded = false;
  if (fresh.length < 5) {
    const wide = await runWindow(nowSec - FAST_PATH_WIDEST_SEC);
    if (wide.length < 5) return null;   // genuinely empty (cold start)
    results = wide;
    degraded = true;
    const oldestMin = Math.round((nowSec - Math.min(...results.map(r => r.ts))) / 60);
    console.warn(`live: fast path DEGRADED — only ${fresh.length} station(s) fresh ` +
                 `within ${FAST_PATH_FRESH_SEC / 60}min; serving ${results.length} ` +
                 `station(s), oldest ${oldestMin}min old. Archive worker likely stalled.`);
  }

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
    }, r.ts != null ? r.ts * 1000 : null);
  });

  const sources = new Set(stations.map(s => s.source)).size;
  return {
    ts: new Date().toISOString(),
    sources,
    stations,
    fast_path: true,            // signals to debug we served from D1
    // Surfaced so a stalled archive worker is visible from the outside without
    // reading logs: `degraded` true means the 30-min rung came up short and
    // this response was assembled from older snapshots. The per-station stale
    // flags are still authoritative for display.
    degraded,
    freshest_count: fresh.length,
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
  // DATA age — a second, independent bound, and the reason it exists:
  // scrape age alone has no upper limit on how dead a sensor may be. IQAir
  // keeps serving a device's page (and its last reading) long after the device
  // itself stops sending anything, so our scrape goes on succeeding, the tile
  // keeps showing the last value, and the station renders LIVE forever.
  // Observed 2026-09-02: "Bali Umalas (Villa Fusion)" was published as 17
  // µg/m³ / "Moderate" / stale:false while its newest actual reading was
  // 2026-08-11T22:00Z — 21 days old — and it was still counted into the island
  // median, "worst right now" and the WHO-exceedance ratios. Our own archive
  // had already stopped recording it (the worker's 48 h guard), so the map was
  // the only place still asserting it.
  //
  // 24 h is deliberately far above the normal lag. IQAir's hourly HISTORIC
  // series trails its live tile by a couple of hours (see FRESH_MS above);
  // measured across the eight healthy stations the gap was under 2 h. A device
  // silent for a full day has stopped, not lagged. Past that we publish a
  // tombstone rather than a reading: pm25 null, off:true, which index.html
  // splits out of liveStations at ingestion (so it touches no median, no
  // worst-now, no WHO ratio) and shows under "Not reporting". Deliberately NOT
  // `absent: true` — unlike a suppressed relay twin, this device really has
  // stopped reporting, so the panel's default copy is the honest one.
  const DATA_DEAD_MS = 24 * 60 * 60 * 1000;
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
    const dataMs = Date.parse(r.latest_ts || '');
    const dataAgeMs = Number.isFinite(dataMs) ? nowMs - dataMs : null;
    if (dataAgeMs != null && dataAgeMs > DATA_DEAD_MS) {
      out.push({
        id: `iqs-${r.slug}`,
        name: r.name,
        source: 'IQAir',
        type: 'Private sensor',
        lat: r.lat,
        lon: r.lon,
        pm25: null, pm10: null, pm1: null, aqi: null,
        pm25_raw: null, pm25_corrected: false,
        temperature: null, humidity: null,
        category: null, cls: 'off',
        off: true,                        // frontends: offline family, not live
        // WITA day of the last real reading, matching scOfflineFromD1().
        offlineSince: new Date(dataMs + 8 * 3600000).toISOString().slice(0, 10),
        lastSeen: r.latest_ts,
        stale: true,                      // never counted as a current reading
        staleAgeHours: Math.max(0, Math.round(dataAgeMs / 3600000)),
      });
      continue;
    }
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
// AirGradient publishes one WORLD feed — 1.4 MB, ~2,700 devices — and Bali is
// about 15 of them. Parsing all of it to keep 15 is wasteful, and on
// 2026-08-24 it was optimised away: the feed was used only to DISCOVER Bali
// device ids, that list cached for 6 h, and each device then read from
// /world/locations/{id}/measures/current. That optimisation is REVERTED, and
// the reason is worth keeping so nobody rebuilds it.
//
// A cached id list cannot see a device that did not exist when it was built.
// AirGradient has been adding Bali units every few days, and each new one was
// invisible here for up to 6 h — and caches.default is PER-COLO, so different
// datacentres held lists of different ages and the symptom moved around. That
// alone would only have meant a missing pin. What made it serious is what sits
// downstream: an OpenAQ relay is suppressed only while its ag-* twin is in the
// same payload (see dropOpenAQNearAirGradient). No ag-* pin meant no pair,
// meant the relay rendered — and OpenAQ carries the sensor's RAW figure while
// we publish the humidity-corrected one. So the map showed materially inflated
// numbers, on exactly the newest sensors, intermittently. Measured on
// production before the revert: three consecutive /api/live?fresh=1 calls
// returned 14, 10 and 10 AirGradient stations against 15 upstream.
//
// The optimisation was bought for real reasons — /api/live?fresh=1 was hitting
// Cloudflare's CPU ceiling (4 failures in 24 h, one 60-minute hole in the
// archive); measured 42-57 ms on this path against 18-32 ms per-device. But it
// traded a BOUNDED, RETRIED failure for an UNBOUNDED, SILENT one. A dropped
// archive tick is now retried three times by the archive worker
// (workers/nafas-archive fetchUnifiedLive); a wrong number on the map is not
// caught by anything and is the one thing this site cannot afford. Correctness
// outranks the CPU saving.
//
// If CPU needs addressing again, the fix is to move the archive tick off the
// request path — not to cache the roster. Any scheme that reads devices
// individually needs a current id list, which means fetching and parsing this
// feed anyway, which leaves the small reads as pure overhead.

// Shared shaping for one raw AirGradient device record, used by both paths so
// the world feed and the per-device endpoint can never drift apart.
function shapeAirGradient(d) {
  {
    const lat = +d?.latitude, lon = +d?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < AG_BALI.latMin || lat > AG_BALI.latMax ||
        lon < AG_BALI.lonMin || lon > AG_BALI.lonMax) return null;
    if (d.offline === true) return null;           // feed marks dead units itself
    // location id must be a clean integer — used as a D1 key + history param.
    const devId = Number.parseInt(d.locationId, 10);
    if (!Number.isFinite(devId) || String(devId) !== String(d.locationId)) return null;
    // Explicit null/empty check BEFORE numeric coercion: the world feed always
    // sends every key and uses null for missing data (verified: 2,528/2,528
    // entries), and units whose PM module died while WiFi stayed up carry
    // pm02:null with offline:false. `+null === 0` is finite, so without this
    // guard a dead module would render — and archive — a phantom 0.0 "Good"
    // reading: false clean-air record, the worst failure direction possible.
    const agNum = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +(+v).toFixed(1);
    const pm25Raw = agNum(d.pm02);
    if (pm25Raw == null) return null;              // must carry a real PM2.5 reading
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
    if (!Number.isFinite(lastMs) || (Date.now() - lastMs) > 24 * 60 * 60 * 1000) return null;
    const { cat, cls } = pm25Category(pm25);
    return ({
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
}

// The two ways to get Bali's AirGradient devices.
async function fetchAirGradient() {
  let list;
  try {
    const r = await fetch(
      'https://api.airgradient.com/public/api/v1/world/locations/measures/current',
      { headers: { Accept: 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true } }
    );
    if (!r.ok) return [];
    list = await r.json();
  } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    const shaped = shapeAirGradient(d);
    if (shaped) out.push(shaped);
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
// unit LEAVES for good, no pair forms and the OpenAQ record stands on its own
// again, exactly like any station we cannot pair.
//
// SUPPRESSION IS UNCONDITIONAL. Once a pair is established, the OpenAQ pin is
// hidden — at any reading, on either side, fresh or stale. This used to carry a
// set of fail-open valves that republished the relay in edge cases: an absolute
// publish threshold, a reference-staleness escape, a ratio test that drew both
// pins side by side, and a proportional source-outage guard. All are gone. The
// reasoning is the one this site applies everywhere else (Smart Citizen
// tombstones, indoor sensors excluded from ambient stats, STALE markers, the
// correction-floor disclosure): an honest gap beats a confident-but-wrong
// number. OpenAQ's raw figure IS wrong — measured, Nyambu relays 39.2 against a
// corrected 25.8 — so a valve that lets it through is a valve that puts a wrong
// number on a public-health map. The thresholds had no ground truth behind them
// and the machinery defending them produced a shipped bug and five
// high-severity review findings, which is a poor trade for a narrow edge case.
// What replaces them is the placeholder: a paired location whose direct feed is
// missing shows a muted grey "not reporting" pin, never a blank space and never
// a number we know to be inflated.
//
// "LEAVES FOR GOOD" IS DECIDED BY OUR OWN ARCHIVE, NOT BY ONE TICK'S PAYLOAD.
// Pairing used to be possible only between two stations present in the SAME
// response, which made suppression of a relay contingent on its twin turning up
// that tick. Any reason an ag-* went missing therefore reverted the map to
// publishing the relay's UNCORRECTED raw figure as if it were the reading, with
// nothing to notice or report it — and one such reason shipped (a 6 h per-colo
// roster cache; see fetchAirGradient). The pair is a durable fact about two
// records of ONE physical device, so it is now also read from our own D1
// catalog (knownRelayPairsFromD1): a twin merely missing from this payload
// keeps its pair, and a GREY PLACEHOLDER stands in its place so the location is
// never left empty. Only a twin that has produced no archived reading for
// TWIN_CATALOG_MAX_AGE_MS counts as departed and hands the spot back.
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
// ratio. What makes discovery strictly SAFER than that 300 m rule is that the
// relay reports the device's coordinates UNCHANGED — all 12 pairs match at
// exactly 0.000000 m, not "nearby" — so TWIN_M is 1 m rather than 300, and
// nothing unrelated is ever within a metre. An earlier version added a second
// test on `type` (OpenAQ names the instrument in provider.name, which this file
// carries through), but it was one-sided — a property of the station being
// suppressed, never a cross-check against the one doing the suppressing — so it
// answered "is this a relay at all", not "is this the RIGHT device", and one
// tick of renamed or missing provider metadata re-leaked the raw number. It is
// gone. The coordinate match and the id tiebreak below are what identify the
// device.
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
// ── THE TIEBREAK IS NOW THE ONLY ANTI-IMPOSTOR DEFENCE ────────────────
// Say it plainly rather than leaving it implicit. The attack is someone
// registering an AirGradient device at the EXACT coordinates of an OpenAQ relay
// in order to suppress that relay and put their own number in its place. There
// used to be a second line of defence behind this tiebreak — a ratio guard that
// refused a suppression which would hide a materially worse relay reading — and
// it is gone (see the header: it was a threshold with no ground truth, and it
// leaked raw figures far more often than it caught anything). So the id
// tiebreak below is what remains, and it covers exactly one of the two cases:
//   • THE GENUINE TWIN IS STILL LIVE — covered. Two ag-* units then sit at one
//     coordinate, the tiebreak takes the lowest id, and ids are issued in
//     ascending order and cannot be chosen, so an impostor can never outrank a
//     device registered earlier. The established unit keeps the pairing and its
//     corrected value; what gets suppressed is the duplicate we did not want.
//   • THE GENUINE TWIN HAS DEPARTED, leaving the relay as the only record of
//     that spot — NOT COVERED. There is no earlier device to lose to, so an
//     impostor's unit wins the pairing unopposed, the relay is suppressed
//     unconditionally, and the impostor's number is what the location shows.
//     This is the residual exposure, and it is real: a relay with no live twin.
// It is bounded by what an attacker must do to reach it — publish a device on a
// public feed, at a coordinate they must first know is orphaned, and keep it
// reporting — and by the fact that an impostor pin enters the published median
// and WHO count whether or not it wins any pairing, which no de-dup rule can
// address. Not by anything in this function. Do not weaken the tiebreak.
//
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
// Closest ag-* within TWIN_M of `s`, tie-broken on the LOWEST NUMERIC id.
// Shared by the in-payload pairing and the D1 catalog pairing below so the two
// can never disagree about which twin a relay belongs to.
//
// Deterministic when a site runs two units at one coordinate: closest first,
// then the LOWEST NUMERIC id. Name is deliberately NOT consulted. It used to be
// the first test, which review showed handed the whole tiebreak to an attacker:
// the AirGradient name is free text on a keyless feed (see fetchAirGradient),
// so an impostor copying the relay's name beat a genuine unit whose name had
// drifted even slightly — and `scClean` truncates at 80 chars and strips
// punctuation, so drift happens on its own. Winning the pairing is what decides
// whose pin stands at that coordinate, so handing it to free text handed it to
// the attacker. Ids are issued in ascending order and cannot be chosen, so
// ordering on id alone means the longer-established device always wins. Cost is
// a rare mis-pick between two genuine units sharing one coordinate — both
// AirGradient, both corrected, so the harm is nil.
function nearestAgTwin(s, agList) {
  let best = null;
  for (const a of agList) {
    const d = metresBetween(s.lat, s.lon, a.lat, a.lon);
    if (d > TWIN_M) continue;
    if (!best) { best = { a, d }; continue; }
    if (d !== best.d) { if (d < best.d) best = { a, d }; continue; }
    if (agIdNum(a.id) < agIdNum(best.a.id)) best = { a, d };
  }
  return best ? best.a : null;
}

// How long an ag-* twin may go without producing an ARCHIVED READING before its
// absence from the payload counts as a departure rather than an anomaly.
//
// This is not a cache TTL: nothing is served from it and no value ages out of
// it. It is the boundary between two states the pairing has to tell apart.
//   • ABSENT — the device is still a live member of the AirGradient feed, but
//     this payload is missing it (upstream blip, a failed fetch, one colo
//     behaving differently, a future optimisation, a snapshot gap that pushes
//     it outside the fast path's 30-minute window). Its relay must stay
//     suppressed and a placeholder must hold the spot.
//   • DEPARTED — the device is gone and its OpenAQ relay is now the only record
//     of that location. The relay must stand on its own again, exactly as it
//     did before the pair ever existed.
//
// MEASURED ON REAL DATA TIME, NOT ON THE PROBE WATERMARK. An earlier draft read
// `stations.last_seen`, which the archive worker refreshes every tick for
// anything /api/live returns — INCLUDING a frozen station whose snapshot it
// deliberately skips. So last_seen kept advancing for a full day after a device
// stopped saying anything, and the pair outlived the data by that much again.
// The test is now MAX(ts) over station_snapshots: the last time we actually
// recorded a reading from that device. Verified against the live catalog, the
// two states separate cleanly on this measure — every reporting Bali unit has a
// data timestamp minutes old, while the two genuinely departed units
// (ag-203997 Shiva Industries, ag-204628 Sibang22, whose relays oq-6494341 and
// oq-6498140 are still published and must remain so) last produced data 7 and 5
// DAYS ago.
//
// WHY 36 h, AND WHY NOT 30 MINUTES. Aligning this with the fast path's 30-minute
// snapshot window — the window that governs whether the ag-* pin appears at all
// — was considered and is incoherent: both tests read the SAME MAX(ts), so at
// 30 minutes a catalog pair could only form while the twin was already in the
// payload, i.e. never when it is needed. The window has to outlast a real
// outage, and it starts from the "this feed is dead, not merely slow" boundary
// this file already uses three times over at 24 h (STALE_THRESHOLD_MS,
// shapeAirGradient's own timestamp cutoff, and therefore the longest an
// in-payload pair could ever have survived a silent device), with half a day of
// margin on top — an outage that begins in the evening is still covered the
// following morning without anyone being awake for it. Owner's call, and it
// errs the way this fold now errs everywhere: toward a grey pin rather than an
// uncorrected number.
//
// It also bounds every failure of the mechanism. Whatever goes wrong — one
// device, our fetch, or AirGradient's whole API — the relays come back within a
// day and a half, and until they do the map shows honest grey "not reporting"
// pins rather than inflated numbers. A systematic regression is loud and safe
// instead of silent and wrong. Above this the device is treated as DEPARTED and
// its relay stands on its own again, which is the only route by which an OpenAQ
// number reaches the map at a location that ever had a twin.
const TWIN_CATALOG_MAX_AGE_MS = 36 * 60 * 60 * 1000;
// Upper sanity bound on an archived timestamp. Snapshot `ts` is written by our
// own worker as unix SECONDS, so anything meaningfully in the future is corrupt
// — review found a millisecond-valued watermark making a 9-day-dead device look
// fresh and suppressing its relay permanently. An hour of slack covers clock
// drift; beyond that the row is ignored, and a device with nothing but corrupt
// rows simply forms no pair (fail open).
const TWIN_CATALOG_FUTURE_SLACK_MS = 60 * 60 * 1000;

// oq id → its ag twin, as recorded in OUR OWN D1 catalog, whether or not either
// station is in the current payload. Values carry everything a suppression
// needs without the twin present: id, name and coordinates for the placeholder,
// and the timestamp of the twin's last archived reading, which is both the
// departure test and the placeholder's "last seen".
//
// It does NOT carry a reference reading. It used to return the twin's most
// recent archived pm25_raw for the anti-burying ratio guard to measure against;
// with that guard gone nothing consumes it, and dropping it removes a
// correlated subquery from the statement below.
//
// WHAT IT PAIRS ON. Coordinates matching within TWIN_M, and `source` — the
// literal strings 'AirGradient' and 'OpenAQ' that THIS file writes into every
// station it emits, which the worker then stores verbatim. It deliberately does
// NOT gate on `type`. An earlier draft did, via /airgradient/i over the OpenAQ
// station's free-text type, which is built from OpenAQ's provider.name and
// rewritten in the catalog every tick: one tick where OpenAQ renames or omits
// the provider poisoned the payload, the fast path and the catalog at once, and
// re-leaked the raw number — the single-point failure the catalog exists to
// remove. Nothing tests `type` anywhere in this fold now.
//
// VALIDATED LIKE PAYLOAD ROWS, because catalog rows are not more trustworthy
// than payload rows. Coordinates are bbox-filtered through AG_BALI in SQL and
// again in JS (which also rejects the (0,0) pair that snapshotUniversal accepts
// as "finite" — review had two corrupt rows pairing at 0 m and deleting a real,
// correctly-located station); timestamps must be inside a sane window at both
// ends; and the caller must still check the PAYLOAD station's own coordinates
// against the catalog row before accepting the pair.
//
// Never throws and never returns partial nonsense: any D1 problem yields an
// empty map, which reduces the fold to exactly its previous behaviour.
async function knownRelayPairsFromD1(db) {
  if (!db) return new Map();
  try {
    const nowMs = Date.now();
    const floorSec = Math.floor((nowMs - TWIN_CATALOG_MAX_AGE_MS) / 1000);
    const ceilSec  = Math.floor((nowMs + TWIN_CATALOG_FUTURE_SLACK_MS) / 1000);
    // ONE correlated subquery, bounded on ts at both ends, so idx_ssnap_id_ts
    // (station_id, ts DESC) answers it with a short range scan rather than a
    // table walk — MAX(ts) over a leading-column equality plus a range is the
    // first row of that scan. The CASE keeps it off the OpenAQ rows, which never
    // need it. The outer scan is the station catalog — dozens of rows.
    const rows = await db.prepare(`
      SELECT s.station_id, s.source, s.name, s.lat, s.lon, s.type,
             CASE WHEN s.source = 'AirGradient' THEN (
               SELECT MAX(x.ts) FROM station_snapshots x
                WHERE x.station_id = s.station_id AND x.ts >= ?1 AND x.ts <= ?2
             ) END AS data_ts
      FROM stations s
      WHERE s.source IN ('AirGradient', 'OpenAQ')
        AND s.lat BETWEEN ?3 AND ?4
        AND s.lon BETWEEN ?5 AND ?6
    `).bind(floorSec, ceilSec,
            AG_BALI.latMin, AG_BALI.latMax,
            AG_BALI.lonMin, AG_BALI.lonMax).all();
    const ag = [], oq = [];
    for (const r of (rows.results || [])) {
      // Explicit null check first: +null coerces to a finite 0, so a NULL-coord
      // row would otherwise land at (0,0) and pair with anything else broken.
      if (!r || r.lat == null || r.lon == null) continue;
      const lat = +r.lat, lon = +r.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < AG_BALI.latMin || lat > AG_BALI.latMax ||
          lon < AG_BALI.lonMin || lon > AG_BALI.lonMax) continue;
      const id = String(r.station_id == null ? '' : r.station_id);
      if (!id) continue;
      if (r.source === 'AirGradient') {
        const ts = r.data_ts == null ? NaN : +r.data_ts;
        if (!Number.isFinite(ts) || ts < floorSec || ts > ceilSec) continue;  // departed / corrupt
        ag.push({
          id, lat, lon,
          name: r.name || id,
          type: r.type || null,
          dataMs: ts * 1000,
        });
      } else if (r.source === 'OpenAQ') {
        oq.push({ id, lat, lon });
      }
    }
    const pairs = new Map();
    if (!ag.length || !oq.length) return pairs;
    for (const s of oq) {
      const twin = nearestAgTwin(s, ag);
      if (twin) pairs.set(s.id, twin);
    }
    return pairs;
  } catch (_) {
    // Fail open — the catalog is corroboration, never a dependency — but mark
    // the failure. Swallowing it made the caller's "catalog read failed" error
    // unreachable dead code: this function never rejected, so the flag it set
    // was permanently false, and a D1 outage silently reverted the map to
    // publishing uncorrected relay figures with nothing in the response to say
    // so. A non-enumerable flag keeps the Map's shape unchanged for callers
    // that only iterate it.
    const empty = new Map();
    Object.defineProperty(empty, 'failed', { value: true, enumerable: false });
    return empty;
  }
}

// oq id → { agId, catalogRow }, for every relay pair this fold should act on.
// In-payload evidence first — it is this tick's real coordinates and can
// tie-break between units actually present — then `knownRelays`, the durable
// catalog pairing above, for a relay whose twin is missing from this payload.
//
// A TOTAL AIRGRADIENT OUTAGE IS NOT SPECIAL-CASED. With zero ag-* stations in
// the payload the honest reading is "our AirGradient source failed" —
// fetchAirGradient returns [] on any upstream failure, and on the fast path a
// single missing archive tick drops every ag-* out of the 30-minute window — and
// the map then goes grey at every relay location at once. A proportional guard
// used to stand here (below half the known roster present, abandon all pairing
// and republish the relays) on the reasoning that the relays were then the only
// picture of Bali's air we had. It is gone with the rest of the fail-open
// valves: what it republished was uncorrected raw figures, dressed as readings,
// at exactly the moment we had least ability to check them. A dozen honest grey
// "not reporting" pins is the correct picture of a source outage.
//
// It must not be SILENT, though, which is a different thing from being
// special-cased. When the payload holds no ag-* at all and the catalog knows of
// twins, `errors` (optional; the caller's results.errors array) gets an entry so
// the outage is visible in the response and not only in the map's appearance.
function pairAirGradientRelays(stations, knownRelays, errors) {
  const pairs = new Map();
  const ag = stations.filter(s =>
    s && s.source === 'AirGradient' && !s.off &&
    Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const catalog = (knownRelays && knownRelays.size) ? knownRelays : null;
  // Alarm only — never a behaviour switch. Measured against the roster the
  // catalog knows about rather than a bare "is any ag-* present" test, because
  // that test was a cliff: ONE surviving unit with no relay of its own, far
  // from every pair, silenced the alarm while the map outcome was identical.
  if (catalog && Array.isArray(errors)) {
    const known = new Set();
    for (const row of catalog.values()) if (row && row.id) known.add(row.id);
    let present = 0;
    for (const a of ag) if (known.has(a.id)) present++;
    if (known.size && present * 2 < known.size) {
      errors.push({
        source: 'airgradient-outage',
        error: `only ${present} of ${known.size} known AirGradient relay twin(s) ` +
               `present in this payload; their relays are suppressed and shown ` +
               `as "not reporting" placeholders`,
      });
    }
  }
  if (!ag.length && !catalog) return pairs;
  for (const s of stations) {
    // Gate on `source`, our own literal, so the catalog lookup is reachable for
    // every OpenAQ station.
    if (!s || s.off || s.source !== 'OpenAQ') continue;
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    // No `type` test here. It was /airgradient/i over OpenAQ's free-text
    // provider name, and a device registered less than one archive tick ago has
    // no catalog row to fall back on — so one poisoned or renamed provider field
    // put the raw number straight back on the map, which is the original bug
    // class. TWIN_M is 1 m precisely because a relay reports the same hardware's
    // coordinates unchanged, so proximity alone is conclusive; nothing unrelated
    // sits within a metre.
    const twin = nearestAgTwin(s, ag);
    if (twin) { pairs.set(s.id, { agId: twin.id, catalogRow: null }); continue; }
    if (!catalog) continue;
    const row = catalog.get(s.id);
    if (!row) continue;
    // The catalog says where the twin is; this payload says where the relay is.
    // Require them to agree before acting on a row we did not fetch this tick.
    if (metresBetween(s.lat, s.lon, row.lat, row.lon) > TWIN_M) continue;
    pairs.set(s.id, { agId: row.id, catalogRow: row });
  }
  return pairs;
}

// Grey "not reporting" pin standing in for an ag-* twin that is absent from the
// payload but whose relay we are suppressing. Never blank a location: without
// this the spot would simply disappear — worse than the inflated number, since
// a visitor cannot tell a suppressed sensor from one that never existed.
//
// Same off:true tombstone shape scOfflineFromD1() already emits, which is what
// makes it free downstream: index.html splits off:true out of liveStations at
// ingestion (so it touches no median, no worst-now, no WHO ratio) and counts it
// under "Not reporting"; history.html files it under Recently offline; and the
// archive worker skips off:true entirely, so a placeholder is never written
// back into D1 and cannot corrupt the record it was built from.
function agAbsentPlaceholder(row) {
  const nowMs = Date.now();
  // Clamp: a device whose last archived reading is stamped now would otherwise
  // report a future lastSeen and a negative age. The isFinite fallback is belt
  // and braces — knownRelayPairsFromD1 validates `ts` before it ever builds a
  // row, so dataMs cannot be NaN here — but the caller no longer re-checks it
  // (that check lived inside a fail-open valve that is gone), and a NaN would
  // otherwise reach `new Date(NaN).toISOString()`, which THROWS. Nothing in
  // this fold may throw: it runs on the visitor's response path.
  const seenMs = Math.min(Number.isFinite(row.dataMs) ? row.dataMs : nowMs, nowMs);
  return {
    id: row.id,
    name: row.name || row.id,
    source: 'AirGradient',
    type: row.type || 'AirGradient monitor',
    lat: row.lat, lon: row.lon,
    pm25: null, pm10: null, pm1: null, aqi: null,
    pm25_raw: null, pm25_corrected: false,
    temperature: null, humidity: null,
    category: null, cls: 'off',
    off: true,                          // frontends: offline family, not live
    // WITA day of the last archived reading, matching scOfflineFromD1's
    // offlineSince (which is a WITA date from station_daily).
    offlineSince: new Date(seenMs + 8 * 3600000).toISOString().slice(0, 10),
    lastSeen: new Date(seenMs).toISOString(),
    stale: true,                        // never counted as a current reading
    staleAgeHours: Math.max(0, Math.round((nowMs - seenMs) / 3600000)),
    // The panel's default copy for an off:true pin says the device has stopped
    // reporting. That is true of a Smart Citizen tombstone and FALSE here: the
    // device is fine, our payload simply arrived without it, which is why we
    // are covering the spot at all. Say that instead of inventing a fault.
    absent: true,
    reasonKey: 'panel.absentSub',
    reason: 'The direct feed is missing from this update. Its co-located relay ' +
            'is held back while it is out, because the relay publishes an ' +
            'uncorrected figure. Historical data is preserved below.',
  };
}
// Collapse each discovered pair to the direct AirGradient pin, whether that pin
// is fresh or stale — a stale pin renders muted ("STALE") and is excluded from
// every published figure, which is the honest state for a paused sensor. The
// relay's number is never swapped in for it, and never republished alongside
// it: once a pair exists the relay is dropped, at any reading, on either side.
//
// A pair whose ag-* half is MISSING FROM THIS PAYLOAD but known to the catalog
// (see knownRelayPairsFromD1) is dropped just the same, and leaves a grey
// "not reporting" placeholder where the twin would have been so the location is
// never blank and never carries a number we know to be uncorrected. The pair
// itself expires on TWIN_CATALOG_MAX_AGE_MS — a twin with no archived reading
// for 36 h has DEPARTED, no pair forms, and the relay stands on its own again.
// That expiry is the whole of the "when does an OpenAQ number publish" rule.
//
// ONE EXCEPTION SURVIVES, and it is about which of two pins to draw rather than
// about thresholds: a blank AirGradient pin (no reading at all — fastPathFromD1
// has no `pm25 IS NOT NULL` filter) does not bury a live OpenAQ value. The ag-*
// pin is dropped and the relay kept, since an empty pin standing in front of a
// reading serves nobody. NOTE this is the one remaining path by which a raw
// OpenAQ figure reaches a PAIRED location; it needs a paired ag-* that is
// present but value-less, which is rare, and it errs toward showing something
// rather than nothing. It was not part of the fail-open machinery removed above
// and is left alone deliberately — if it should go too, the fix is to delete
// these three lines and the relay disappears behind a numberless ag-* pin.
function dropOpenAQNearAirGradient(stations, knownRelays, errors) {
  const pairs = pairAirGradientRelays(stations, knownRelays, errors);
  if (!pairs.size) return stations;
  const byId = new Map();
  for (const s of stations) {
    if (!s || s.id == null) continue;
    // Never collapse two rows onto one key: a duplicated id in an upstream feed
    // would otherwise let a single drop decision remove BOTH copies.
    if (byId.has(s.id)) { byId.set(s.id, null); continue; }
    byId.set(s.id, s);
  }
  const drop = new Set();
  const placeholders = new Map();   // agId → grey pin, deduped across relays
  for (const [oqId, pair] of pairs) {
    const oq = byId.get(oqId);
    if (!oq) continue;
    const agId = pair.agId;
    if (byId.has(agId)) {
      const ag = byId.get(agId);
      if (!ag) continue;   // duplicated ag id upstream (byId sentinel) — decide nothing
      // NO EXCEPTION for a value-less twin. This used to drop the ag-* pin and
      // publish the relay when ag.pm25 was null, on the reasoning that a blank
      // pin should not bury a reading. Under the AirGradient-only rule that is
      // backwards: a present-but-blank ag-* is still an AirGradient sensor at
      // that location, and the relay's number is uncorrected, so publishing it
      // was the one remaining path by which a raw figure reached a paired spot.
      // The location now shows the direct pin with no number, which is the
      // honest statement — the sensor is there and is not reporting a value.
      drop.add(oqId);
      continue;
    }
    // ── Twin absent from this payload: catalog-only pair ──────────────
    // Suppress and stand a placeholder in the twin's place. This branch used to
    // be held to a higher bar than the in-payload one — three fail-open tests
    // and a ratio guard — on the reasoning that a mistaken suppression here
    // leaves NO number at that location rather than merely a different one. The
    // owner's decision is that a grey "not reporting" pin IS the right answer
    // when the only figure available is an uncorrected relay: it is a gap the
    // visitor can see and interpret, where the relay's number is a wrong answer
    // they cannot. So: no thresholds, no reference reading, no ratio.
    const row = pair.catalogRow;
    if (!row) continue;   // in-payload pair with a vanished twin: impossible, but never suppress blind
    drop.add(oqId);
    // Never blank the location. One placeholder per twin even if two relays
    // resolve to it.
    if (!placeholders.has(agId)) placeholders.set(agId, agAbsentPlaceholder(row));
  }
  if (!drop.size && !placeholders.size) return stations;
  const kept = drop.size ? stations.filter(s => !(s && drop.has(s.id))) : stations.slice();
  for (const p of placeholders.values()) kept.push(p);
  return kept;
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

  // Durable OpenAQ↔AirGradient relay pairing from our own catalog, so a relay
  // stays suppressed — and its twin's spot stays occupied — on a tick where the
  // direct feed is missing that device (see knownRelayPairsFromD1). ONE read per
  // request, shared by whichever path serves it.
  //
  // Started here rather than at the point of use so it overlaps the fast path's
  // own query instead of adding a serial round trip. SKIPPED ENTIRELY on
  // ?fresh=1: that is the archive worker, which does not run the display folds
  // at all and is the caller measured against Cloudflare's CPU ceiling — it
  // must pay nothing for this, and must keep receiving both halves of every
  // pair or a suppressed station stops being archived under its own id.
  const relayPairsP = (env.ARCHIVE_DB && !noFast)
    ? knownRelayPairsFromD1(env.ARCHIVE_DB)
    : null;
  // Resolved defensively at every call site, like every other D1 touch in this
  // function: knownRelayPairsFromD1 already swallows its own failures, but a
  // bare `await` on a shared promise is one refactor away from being the only
  // unguarded database call on the path.
  // Failing open here is deliberate — a catalog outage must never blank the map
  // — but it is NOT harmless: with no catalog, a relay whose twin is missing
  // publishes its raw figure again, which is the leak this whole mechanism
  // exists to close. So record it. A silent fallback that quietly reverts the
  // site to the buggy behaviour is exactly the kind of thing that goes
  // unnoticed for weeks.
  let relayPairsFailed = false;
  const relayPairs = async () => {
    if (!relayPairsP) return new Map();
    try {
      const m = await relayPairsP;
      if (m && m.failed) relayPairsFailed = true;   // see knownRelayPairsFromD1
      return m || new Map();
    } catch (_) { relayPairsFailed = true; return new Map(); }
  };

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
        // its own only once the AG unit has produced no archived reading for
        // 36 h, and until then a grey placeholder holds its spot.
        //
        // The fold reports source outages into `foldErrors`. The fast path had
        // no errors array at all, so a total AirGradient outage — the state
        // where every relay location goes grey at once — was visible only in
        // the map's appearance. It is the path most visitors are served and the
        // one where the outage is most likely (a single missing archive tick
        // empties the 30-minute window), so it is exactly where the signal has
        // to exist. Attached only when non-empty, so the normal response shape
        // is unchanged; nothing in public/ reads this field either way.
        const foldErrors = [];
        fast.stations = dropOpenAQNearAirGradient(fast.stations, await relayPairs(), foldErrors);
        if (relayPairsFailed) {
          foldErrors.push({ source: 'relay-catalog',
            error: 'known-relay catalog read failed; relays fall back to publishing raw figures' });
        }
        if (foldErrors.length) fast.errors = foldErrors;
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
  // ARCHIVE_DB block on purpose: neither fold reads the database itself, so
  // both still run for a visitor served the slow path with no binding present —
  // the relay pairing simply arrives as an empty map and the AirGradient fold
  // falls back to in-payload pairs, exactly as it behaved before.
  if (!noFast) {
    results.stations = dropAirlyNearNafas(results.stations);
    // results.errors is the fold's outage sink: a payload with zero ag-* while
    // the catalog knows of twins is our own fetch failing, and the map going
    // grey at every relay location is the correct outcome — but not a silent one.
    results.stations = dropOpenAQNearAirGradient(results.stations, await relayPairs(), results.errors);
    results.sources = new Set(results.stations.filter(s => !s.off).map(s => s.source)).size;
  }
  if (relayPairsFailed) {
    results.errors.push({ source: 'relay-catalog',
      error: 'known-relay catalog read failed; relays fall back to publishing raw figures' });
  }
  if (results.errors.length === 0) delete results.errors;
  return jsonResponse(results);
}
