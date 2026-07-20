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
function isRecent(isoStr) {
  if (!isoStr) return false;
  return (Date.now() - new Date(isoStr).getTime()) < 6 * 60 * 60 * 1000;
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
function flagStale(station) {
  const ms = parseLastSeenMs(station.lastSeen);
  if (ms == null) return station;
  if (Date.now() - ms > STALE_THRESHOLD_MS) {
    station.stale = true;
    station.staleAgeHours = Math.round((Date.now() - ms) / 3600000);
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
           sn.station_till, sn.ts
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
    'https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,pm2.5,last_seen&location_type=0&nwlat=-8.0&nwlng=114.4&selat=-8.92&selng=115.78',
    { headers: { 'X-API-Key': env.PURPLEAIR_API_KEY } }
  );
  const data = await r.json();
  if (!data?.data) return [];
  const f = data.fields;
  return data.data.map(row => {
    const pm = row[f.indexOf('pm2.5')];
    const { cat, cls } = pm25Category(pm);
    return {
      id: `pa-${row[0]}`,
      name: row[f.indexOf('name')],
      source: 'PurpleAir',
      type: 'Community sensor',
      lat: row[f.indexOf('latitude')],
      lon: row[f.indexOf('longitude')],
      pm25: pm != null ? +pm.toFixed(1) : null,
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
    const pm25 = agNum(d.pm02);
    if (pm25 == null) continue;                 // must carry a real PM2.5 reading
    // Staleness backstop (mirrors Smart Citizen): if the feed's own timestamp
    // is >24 h old despite offline:false, don't surface it as live air.
    const lastMs = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (Number.isFinite(lastMs) && (Date.now() - lastMs) > 24 * 60 * 60 * 1000) continue;
    const { cat, cls } = pm25Category(pm25);
    out.push({
      id: `ag-${devId}`,
      name: scClean(d.publicLocationName || d.locationName) || `AirGradient #${devId}`,
      source: 'AirGradient',
      type: scClean('AirGradient ' + (d.model || 'monitor')),
      lat, lon,
      pm25,
      pm10: agNum(d.pm10),
      pm1:  agNum(d.pm01),
      temperature: agNum(d.atmp),
      humidity:    agNum(d.rhum),
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
// made later, on the fast path only, by dropOpenAQNearAirGradient().
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

// Airly de-dup (display only). Both Bali Airly installations are Nafas-SPONSORED
// hardware co-located (~12 m) with a Nafas station, publishing the same readings
// (daily-mean r≈0.97, mean |Δ|<1 µg/m³). Show one pin: drop any Airly station
// within 300 m of a FRESH (non-stale) Nafas station. If Nafas isn't reporting
// that spot, the Airly is kept → automatic failover to the redundant feed.
// Applied ONLY to the served fast-path response — the archive worker reads the
// slow path (?fresh=1) and keeps snapshotting BOTH into D1, so the failover
// history is preserved and the Airly reappears the moment Nafas goes quiet.
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
// Two Bali AirGradient units reach us twice: once straight from AirGradient's
// public feed (ag-*), once relayed through OpenAQ (oq-*). Verified same
// physical hardware, 0 m apart: ag-195872 == oq-6403967 (Kuwum) and
// ag-196524 == oq-6413387 (Tabanan). The relayed copy is materially worse:
// OpenAQ republishes ~hourly aggregates (our archive shows those stations'
// values moving only every ~1.3–1.4 h despite 15-min polling) while the direct
// feed is instantaneous and timestamped to the minute — a live spot-check had
// Tabanan at 10.3 via OpenAQ against 6.5 raw via AirGradient at the same moment.
// So: drop any OpenAQ station within 300 m of a FRESH AirGradient station. If
// the AirGradient feed goes quiet, its pin ages out of the fast path (or flags
// stale) and the OpenAQ pin returns on its own — automatic failover to the
// redundant relay, exactly like dropAirlyNearNafas.
//
// Applied ONLY to the served fast path. The archive worker reads the slow path
// (?fresh=1) and keeps snapshotting BOTH, so oq-* history stays continuous and
// untouched under its own id while ag-* builds a clean raw 15-min record.
// Verified relay pairs: OpenAQ id → the AirGradient id that is the SAME physical
// unit (both confirmed 0 m apart, carrying identical names). Deliberately an
// explicit pairing rather than pure geometry: AirGradient is a consumer product
// on a worldwide public feed, and an unrelated new unit parked a couple of
// hundred metres from an OpenAQ-only station (Umadawa has open ground that
// close) would otherwise silently delete a genuine, distinct sensor from the map
// AND from the history picker. Suppression is only ever safe for hardware we
// have actually confirmed is the same device. A third pair is a one-line edit.
const AG_OQ_TWINS = new Map([
  ['oq-6403967', 'ag-195872'],  // Kuwum, Bali
  ['oq-6413387', 'ag-196524'],  // Tabanan
]);
function dropOpenAQNearAirGradient(stations) {
  const DEDUP_M = 300;
  // A suppressing twin must carry an actual reading: fastPathFromD1 has no
  // pm25 IS NOT NULL filter, so a null-reading AG snapshot would otherwise
  // hide a live OpenAQ value behind a blank pin.
  const freshAG = new Map();
  for (const s of stations) {
    if (s && s.source === 'AirGradient' && !s.stale && !s.off &&
        Number.isFinite(s.pm25) &&
        Number.isFinite(s.lat) && Number.isFinite(s.lon)) freshAG.set(s.id, s);
  }
  if (!freshAG.size) return stations;  // no live AirGradient → keep OpenAQ (failover)
  return stations.filter(s => {
    if (!s || s.source !== 'OpenAQ') return true;
    const twin = freshAG.get(AG_OQ_TWINS.get(s.id));
    if (!twin) return true;              // unpaired, or twin absent/stale/blank → keep (failover)
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return true;
    // Sanity check: if a "pair" has drifted apart, the pairing is stale — keep both.
    return !(metresBetween(s.lat, s.lon, twin.lat, twin.lon) < DEDUP_M);
  });
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
        // (fresher, 15-min, un-aggregated). Failover: if AirGradient goes
        // quiet, the OpenAQ pin comes back on its own.
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
  if (results.errors.length === 0) delete results.errors;
  return jsonResponse(results);
}
