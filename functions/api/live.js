// Cloudflare Pages Function — fetches live air quality data server-side
// API keys stored in Cloudflare env vars (Settings → Environment Variables), never exposed to browser
// Sources: PurpleAir, AQICN, IQAir, Airly, Nafas (public JSON feed), OpenAQ (AirGradient)

export async function onRequest(context) {
  const env = context.env;
  const PURPLEAIR_KEY = env.PURPLEAIR_API_KEY;
  const AQICN_TOKEN = env.AQICN_TOKEN;
  const IQAIR_KEY = env.IQAIR_API_KEY;
  const AIRLY_KEY = env.AIRLY_API_KEY;
  const OPENAQ_KEY = env.OPENAQ_API_KEY;

  const results = { ts: new Date().toISOString(), sources: 0, stations: [], errors: [] };

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

  // ── 1. PurpleAir ──
  // Bali bbox covers the whole island including the north (Lovina, Singaraja)
  // and the southern tip (Uluwatu). Extends a touch into the surrounding sea.
  try {
    const resp = await fetch('https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,pm2.5,last_seen&location_type=0&nwlat=-8.0&nwlng=114.4&selat=-8.92&selng=115.78', {
      headers: { 'X-API-Key': PURPLEAIR_KEY }
    });
    const data = await resp.json();
    if (data.data) {
      results.sources++;
      const f = data.fields;
      for (const row of data.data) {
        const pm = row[f.indexOf('pm2.5')];
        const { cat, cls } = pm25Category(pm);
        results.stations.push({
          id: `pa-${row[0]}`, name: row[f.indexOf('name')], source: 'PurpleAir', type: 'Community sensor',
          lat: row[f.indexOf('latitude')], lon: row[f.indexOf('longitude')],
          pm25: pm != null ? +pm.toFixed(1) : null, aqi: null, category: cat, cls,
          lastSeen: row[f.indexOf('last_seen')] ? new Date(row[f.indexOf('last_seen')] * 1000).toISOString() : null,
        });
      }
    }
  } catch (e) { results.errors.push({ source: 'PurpleAir', error: e.message }); }

  // ── 2. AQICN ──
  try {
    const resp = await fetch(`https://api.waqi.info/v2/map/bounds?latlng=-8.92,114.4,-8.0,115.78&networks=all&token=${AQICN_TOKEN}`);
    const data = await resp.json();
    if (data.status === 'ok' && data.data) {
      results.sources++;
      for (const s of data.data) {
        try {
          const dr = await fetch(`https://api.waqi.info/feed/@${s.uid}/?token=${AQICN_TOKEN}`);
          const dd = await dr.json();
          const pm25 = dd?.data?.iaqi?.pm25?.v;
          const { cat, cls } = pm25Category(pm25);
          const isGov = dd?.data?.attributions?.[0]?.name?.includes('KLHK') || dd?.data?.attributions?.[0]?.name?.includes('Kementerian');
          results.stations.push({
            id: `aq-${s.uid}`, name: s.station?.name || 'Unknown', source: 'AQICN',
            type: isGov ? 'Government (KLHK)' : 'GAIA Network',
            lat: s.lat, lon: s.lon, pm25: pm25 != null ? +pm25 : null, aqi: +s.aqi || null,
            category: cat, cls, lastSeen: dd?.data?.time?.iso || null,
          });
        } catch (_) {}
      }
    }
  } catch (e) { results.errors.push({ source: 'AQICN', error: e.message }); }

  // ── 3. Airly network ──
  // Note: historically we relabelled `sponsor.name ∈ {Nafas, DBS}` Airly installations
  // as "Nafas", on the assumption they were the same hardware. Verified against the
  // Nafas public station list (outdoor.nafas.co.id /api/v1/location/all) — no Bali
  // UUID overlap. The relabel was incorrect and has been removed. Airly stations
  // now always report source='Airly'.
  // Edition III: 100 km from Ubud centre already covers the full island
  // (Lovina ~50 km north, Negara ~75 km west, Amlapura ~40 km east). Bumped
  // maxResults to 50. (Tested: maxDistanceKM=200 returns empty on free tier.)
  try {
    const resp = await fetch('https://airapi.airly.eu/v2/installations/nearest?lat=-8.55&lng=115.26&maxDistanceKM=100&maxResults=50', {
      headers: { Accept: 'application/json', apikey: AIRLY_KEY }
    });
    const installations = await resp.json();
    if (Array.isArray(installations) && installations.length > 0) {
      results.sources++;
      for (const inst of installations) {
        try {
          const mr = await fetch(`https://airapi.airly.eu/v2/measurements/installation?installationId=${inst.id}`, {
            headers: { Accept: 'application/json', apikey: AIRLY_KEY }
          });
          const md = await mr.json();
          const cur = md?.current;
          if (!cur) continue;
          let pm25=null, pm1=null, pm10=null, temp=null, humidity=null;
          for (const v of (cur.values||[])) {
            if (v.name==='PM25') pm25=+v.value.toFixed(1);
            if (v.name==='PM1') pm1=+v.value.toFixed(1);
            if (v.name==='PM10') pm10=+v.value.toFixed(1);
            if (v.name==='TEMPERATURE') temp=+v.value.toFixed(1);
            if (v.name==='HUMIDITY') humidity=+v.value.toFixed(1);
          }
          const { cat, cls } = pm25Category(pm25);
          const addr = inst.address||{};
          const sponsor = inst.sponsor?.name||'';
          results.stations.push({
            id: `airly-${inst.id}`,
            name: [addr.displayAddress1, addr.displayAddress2].filter(Boolean).join(', ') || `Airly #${inst.id}`,
            source: 'Airly',
            type: sponsor ? `${sponsor}-sponsored Airly sensor` : 'Airly sensor',
            lat: inst.location?.latitude, lon: inst.location?.longitude,
            pm25, pm1, pm10, temperature: temp, humidity,
            aqi: cur.indexes?.[0]?.value ? +cur.indexes[0].value.toFixed(0) : null,
            category: cat, cls, lastSeen: cur.tillDateTime || null,
          });
        } catch (_) {}
      }
    }
  } catch (e) { results.errors.push({ source: 'Airly', error: e.message }); }

  // ── 3b. Nafas Foundation — Indonesia-specific PM/met sensor network ──
  // Public JSON backend (same endpoint that share.nafas.co.id consumes).
  // No auth, no rate limiting. Nafas devices are PM + met only (no gas sensors).
  // Polling cadence here (per request) is well below their ~15 min refresh.
  try {
    const allResp = await fetch('https://outdoor.nafas.co.id/api/v1/location/all', {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 180, cacheEverything: true },
    });
    if (allResp.ok) {
      const allData = await allResp.json();
      if (allData?.success && Array.isArray(allData.body)) {
        // Bali bbox filter — ingest only Bali stations, not all 184 nationwide.
        const BALI = { latMin: -9.2, latMax: -8.0, lonMin: 114.4, lonMax: 115.8 };
        const baliStations = allData.body.filter(loc => {
          const lat = +loc.latitude, lon = +loc.longitude;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
          if (loc.visible === false) return false;
          return lat >= BALI.latMin && lat <= BALI.latMax &&
                 lon >= BALI.lonMin && lon <= BALI.lonMax;
        });

        if (baliStations.length > 0) results.sources++;

        // Fetch per-station detail in parallel (6 stations → 6 concurrent requests)
        const details = await Promise.all(baliStations.map(async (loc) => {
          try {
            const dr = await fetch(`https://outdoor.nafas.co.id/api/v1/location/detail/${loc.uuid}`, {
              headers: { Accept: 'application/json' },
              cf: { cacheTtl: 180, cacheEverything: true },
            });
            if (!dr.ok) return { loc, detail: null };
            const dd = await dr.json();
            return { loc, detail: dd?.body || null };
          } catch { return { loc, detail: null }; }
        }));

        for (const { loc, detail } of details) {
          const num = (v) => {
            if (v == null || v === '') return null;
            const n = +v;
            return Number.isFinite(n) ? +n.toFixed(1) : null;
          };
          const d = detail || loc; // fall back to /all row if detail failed
          const pm25 = num(d.pm25);
          const pm10 = num(d.pm10);
          const pm1  = num(d.pm1);
          const temp = num(d.temperature);
          const hum  = num(d.humidity);
          const aqi  = d.aqi != null ? +d.aqi : (loc.aqi != null ? +loc.aqi : null);
          const { cat, cls } = pm25Category(pm25);
          results.stations.push({
            id: `nafas-${loc.uuid}`,
            name: loc.name || `Nafas ${String(loc.uuid).slice(0, 8)}`,
            source: 'Nafas',
            type: 'Nafas Foundation sensor',
            lat: +loc.latitude,
            lon: +loc.longitude,
            pm25, pm1, pm10, temperature: temp, humidity: hum,
            aqi: Number.isFinite(aqi) ? aqi : null,
            category: cat, cls,
            lastSeen: d.till || loc.till || null,
            nafas_uuid: loc.uuid,
          });
        }
      }
    }
  } catch (e) { results.errors.push({ source: 'Nafas', error: e.message }); }

  // ── 4. OpenAQ (AirGradient sensors) ──
  // Edition III: 5 search centres covering full Bali — north (Lovina), centre (Ubud),
  // south Denpasar/Kuta, west (Negara/Tabanan), east (Amed/Karangasem). 25 km radius
  // each. Stations are de-duped by id below.
  try {
    const centers = [
      {lat:-8.16, lon:115.10},  // North coast (Lovina, Singaraja)
      {lat:-8.50, lon:115.26},  // Ubud / centre
      {lat:-8.65, lon:115.22},  // Denpasar / south-central
      {lat:-8.80, lon:115.14},  // Kuta / Jimbaran
      {lat:-8.35, lon:114.65},  // West (Tabanan / Negara)
      {lat:-8.45, lon:115.65},  // East (Amlapura / Karangasem)
    ];
    const seenIds = new Set();
    let foundAny = false;
    for (const c of centers) {
      try {
        const resp = await fetch(`https://api.openaq.org/v3/locations?coordinates=${c.lat},${c.lon}&radius=25000&limit=20`, {
          headers: { Accept: 'application/json', 'X-API-Key': OPENAQ_KEY }
        });
        const data = await resp.json();
        for (const loc of (data.results||[])) {
          if (seenIds.has(loc.id)) continue;
          seenIds.add(loc.id);
          try {
            const lr = await fetch(`https://api.openaq.org/v3/locations/${loc.id}/latest`, {
              headers: { Accept: 'application/json', 'X-API-Key': OPENAQ_KEY }
            });
            const ld = await lr.json();
            let pm25=null, lastSeen=null;
            for (const r of (ld.results||[])) {
              const pn = r.parameter?.name||'';
              if (pn.toLowerCase().includes('pm25')||pn.toLowerCase().includes('pm2')) {
                pm25 = r.value!=null ? +r.value.toFixed(1) : null;
                lastSeen = r.datetime?.local || r.datetime?.utc || null;
              }
            }
            if (!lastSeen || (Date.now()-new Date(lastSeen).getTime()) > 30*24*60*60*1000) continue;
            const { cat, cls } = pm25Category(pm25);
            if (!foundAny) { results.sources++; foundAny=true; }
            results.stations.push({
              id: `oq-${loc.id}`, name: loc.name||`OpenAQ #${loc.id}`, source: 'OpenAQ',
              type: `${loc.provider?.name||'?'} sensor`,
              lat: loc.coordinates?.latitude, lon: loc.coordinates?.longitude,
              pm25, aqi: null, category: cat, cls, lastSeen, stale: !isRecent(lastSeen),
            });
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (e) { results.errors.push({ source: 'OpenAQ', error: e.message }); }

  // ── 5. IQAir (rate limited — last) ──
  // Edition III: add north (Lovina), east (Amlapura), and Bedugul to the
  // nearest_city probes so any IQAir contributor in those regions appears.
  const iqLocs = [
    {label:'Denpasar',           lat:-8.65, lon:115.22},
    {label:'Ubud',               lat:-8.50, lon:115.26},
    {label:'Kerobokan / Seminyak',lat:-8.67, lon:115.15},
    {label:'Jimbaran',           lat:-8.79, lon:115.17},
    {label:'Lovina (north)',     lat:-8.16, lon:115.02},
    {label:'Amlapura (east)',    lat:-8.45, lon:115.61},
    {label:'Bedugul (mountains)',lat:-8.28, lon:115.16},
  ];
  let iqOk = false;
  for (const loc of iqLocs) {
    try {
      const resp = await fetch(`https://api.airvisual.com/v2/nearest_city?lat=${loc.lat}&lon=${loc.lon}&key=${IQAIR_KEY}`);
      const data = await resp.json();
      if (data.status==='success') {
        if (!iqOk) { results.sources++; iqOk=true; }
        const d=data.data, aqi=d.current?.pollution?.aqius, mp=d.current?.pollution?.mainus;
        const pm25Est = mp==='p2' ? aqiToPm25(aqi) : null;
        const { cat, cls } = pm25Category(pm25Est!=null ? pm25Est : aqiToPm25(aqi));
        const dk = `iq-${d.city}`;
        if (!results.stations.find(s=>s.id===dk)) {
          results.stations.push({
            id: dk, name: `${loc.label} (${d.city})`, source: 'IQAir', type: 'Private sensor',
            lat: d.location?.coordinates?.[1], lon: d.location?.coordinates?.[0],
            pm25: pm25Est, pm25_estimated: mp==='p2', aqi, category: cat, cls,
            lastSeen: d.current?.pollution?.ts || null,
          });
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1200));
  }

  // Clean up empty errors array
  if (results.errors.length === 0) delete results.errors;

  return new Response(JSON.stringify(results), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
