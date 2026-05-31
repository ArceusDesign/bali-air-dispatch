// Cloudflare Pages Function — fetches live air quality data server-side.
// API keys stored in Cloudflare env vars (Settings → Environment Variables),
// never exposed to browser.
// Sources: PurpleAir, AQICN, IQAir, Airly, Nafas (public JSON feed),
// OpenAQ (AirGradient).
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
    const aqi = dd.current?.pollution?.aqius;
    const mp = dd.current?.pollution?.mainus;
    const pm25Est = mp === 'p2' ? aqiToPm25(aqi) : null;
    const { cat, cls } = pm25Category(pm25Est != null ? pm25Est : aqiToPm25(aqi));
    const dk = `iq-${loc.slug || dd.city}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({
      id: dk,
      name: `${loc.label} (${dd.city})`,
      source: 'IQAir',
      type: 'Private sensor',
      lat: dd.location?.coordinates?.[1],
      lon: dd.location?.coordinates?.[0],
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
      if (fast) return jsonResponse(fast);
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
  if (results.errors.length === 0) delete results.errors;
  return jsonResponse(results);
}
