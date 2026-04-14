// Vercel Serverless Function — fetches live air quality data server-side
// API keys are stored in Vercel environment variables, never exposed to the browser
// Sources: PurpleAir, AQICN, IQAir, Airly (Nafas sensors), OpenAQ (AirGradient)

export default async function handler(req, res) {
  const PURPLEAIR_KEY = process.env.PURPLEAIR_API_KEY;
  const AQICN_TOKEN = process.env.AQICN_TOKEN;
  const IQAIR_KEY = process.env.IQAIR_API_KEY;
  const AIRLY_KEY = process.env.AIRLY_API_KEY;
  const OPENAQ_KEY = process.env.OPENAQ_API_KEY;

  const results = { ts: new Date().toISOString(), sources: 0, stations: [] };

  // Helper: AQI (US EPA) to approximate PM2.5 µg/m³
  function aqiToPm25(aqi) {
    if (aqi <= 50) return +(aqi * 12.0 / 50).toFixed(1);
    if (aqi <= 100) return +(12.1 + (aqi - 51) * (35.4 - 12.1) / 49).toFixed(1);
    if (aqi <= 150) return +(35.5 + (aqi - 101) * (55.4 - 35.5) / 49).toFixed(1);
    if (aqi <= 200) return +(55.5 + (aqi - 151) * (150.4 - 55.5) / 49).toFixed(1);
    if (aqi <= 300) return +(150.5 + (aqi - 201) * (250.4 - 150.5) / 99).toFixed(1);
    return +(250.5 + (aqi - 301) * (500.4 - 250.5) / 199).toFixed(1);
  }

  // Helper: PM2.5 to EPA category
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

  // Helper: check if data is recent (within 6 hours)
  function isRecent(isoStr) {
    if (!isoStr) return false;
    const diff = Date.now() - new Date(isoStr).getTime();
    return diff < 6 * 60 * 60 * 1000;
  }

  // ── 1. PurpleAir ──
  try {
    const paUrl = 'https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,pm2.5,last_seen&location_type=0&nwlat=-8.1&nwlng=114.4&selat=-8.85&selng=115.7';
    const paResp = await fetch(paUrl, { headers: { 'X-API-Key': PURPLEAIR_KEY } });
    const paData = await paResp.json();
    if (paData.data) {
      results.sources++;
      const fields = paData.fields;
      const nameIdx = fields.indexOf('name');
      const pm25Idx = fields.indexOf('pm2.5');
      const latIdx = fields.indexOf('latitude');
      const lonIdx = fields.indexOf('longitude');
      const seenIdx = fields.indexOf('last_seen');

      for (const row of paData.data) {
        const pm = row[pm25Idx];
        const { cat, cls } = pm25Category(pm);
        results.stations.push({
          id: `pa-${row[0]}`,
          name: row[nameIdx],
          source: 'PurpleAir',
          type: 'Community sensor',
          lat: row[latIdx],
          lon: row[lonIdx],
          pm25: pm != null ? +pm.toFixed(1) : null,
          aqi: null,
          category: cat,
          cls,
          lastSeen: row[seenIdx] ? new Date(row[seenIdx] * 1000).toISOString() : null,
        });
      }
    }
  } catch (e) {
    results.errors = results.errors || [];
    results.errors.push({ source: 'PurpleAir', error: e.message });
  }

  // ── 2. AQICN ──
  try {
    const aqUrl = `https://api.waqi.info/v2/map/bounds?latlng=-8.85,114.4,-8.1,115.7&networks=all&token=${AQICN_TOKEN}`;
    const aqResp = await fetch(aqUrl);
    const aqData = await aqResp.json();
    if (aqData.status === 'ok' && aqData.data) {
      results.sources++;
      for (const s of aqData.data) {
        try {
          const detUrl = `https://api.waqi.info/feed/@${s.uid}/?token=${AQICN_TOKEN}`;
          const detResp = await fetch(detUrl);
          const detData = await detResp.json();
          const pm25 = detData?.data?.iaqi?.pm25?.v;
          const { cat, cls } = pm25Category(pm25);
          results.stations.push({
            id: `aq-${s.uid}`,
            name: s.station?.name || 'Unknown',
            source: 'AQICN',
            type: detData?.data?.attributions?.[0]?.name?.includes('KLHK') || detData?.data?.attributions?.[0]?.name?.includes('Kementerian') ? 'Government (KLHK)' : 'GAIA Network',
            lat: s.lat,
            lon: s.lon,
            pm25: pm25 != null ? +pm25 : null,
            aqi: +s.aqi || null,
            category: cat,
            cls,
            lastSeen: detData?.data?.time?.iso || s.station?.time || null,
          });
        } catch (detErr) { /* skip */ }
      }
    }
  } catch (e) {
    results.errors = results.errors || [];
    results.errors.push({ source: 'AQICN', error: e.message });
  }

  // ── 3. Airly (Nafas sensors) ──
  try {
    const airlyUrl = 'https://airapi.airly.eu/v2/installations/nearest?lat=-8.55&lng=115.26&maxDistanceKM=100&maxResults=25';
    const airlyResp = await fetch(airlyUrl, { headers: { Accept: 'application/json', apikey: AIRLY_KEY } });
    const airlyInstallations = await airlyResp.json();

    if (Array.isArray(airlyInstallations) && airlyInstallations.length > 0) {
      results.sources++;
      for (const inst of airlyInstallations) {
        try {
          const measUrl = `https://airapi.airly.eu/v2/measurements/installation?installationId=${inst.id}`;
          const measResp = await fetch(measUrl, { headers: { Accept: 'application/json', apikey: AIRLY_KEY } });
          const measData = await measResp.json();

          const cur = measData?.current;
          if (!cur) continue;

          let pm25 = null;
          let pm1 = null;
          let pm10 = null;
          let temp = null;
          let humidity = null;
          for (const v of (cur.values || [])) {
            if (v.name === 'PM25') pm25 = +v.value.toFixed(1);
            if (v.name === 'PM1') pm1 = +v.value.toFixed(1);
            if (v.name === 'PM10') pm10 = +v.value.toFixed(1);
            if (v.name === 'TEMPERATURE') temp = +v.value.toFixed(1);
            if (v.name === 'HUMIDITY') humidity = +v.value.toFixed(1);
          }

          const { cat, cls } = pm25Category(pm25);
          const addr = inst.address || {};
          const sponsor = inst.sponsor?.name || '';
          const stationName = [addr.displayAddress1, addr.displayAddress2].filter(Boolean).join(', ');

          results.stations.push({
            id: `airly-${inst.id}`,
            name: stationName || `Airly #${inst.id}`,
            source: 'Airly',
            type: sponsor ? `${sponsor} sensor` : 'Airly sensor',
            lat: inst.location?.latitude,
            lon: inst.location?.longitude,
            pm25,
            pm1,
            pm10,
            temperature: temp,
            humidity,
            aqi: cur.indexes?.[0]?.value ? +cur.indexes[0].value.toFixed(0) : null,
            category: cat,
            cls,
            lastSeen: cur.tillDateTime || null,
          });
        } catch (measErr) { /* skip */ }
      }
    }
  } catch (e) {
    results.errors = results.errors || [];
    results.errors.push({ source: 'Airly', error: e.message });
  }

  // ── 4. OpenAQ (AirGradient sensors) ──
  try {
    // Search multiple center points to cover Bali (25km radius limit)
    const centers = [
      { lat: -8.5, lon: 115.26 },
      { lat: -8.65, lon: 115.22 },
      { lat: -8.8, lon: 115.14 },
    ];
    const seenIds = new Set();
    let foundAny = false;

    for (const c of centers) {
      try {
        const oqUrl = `https://api.openaq.org/v3/locations?coordinates=${c.lat},${c.lon}&radius=25000&limit=20`;
        const oqResp = await fetch(oqUrl, { headers: { Accept: 'application/json', 'X-API-Key': OPENAQ_KEY } });
        const oqData = await oqResp.json();

        for (const loc of (oqData.results || [])) {
          if (seenIds.has(loc.id)) continue;
          seenIds.add(loc.id);

          // Get latest readings
          try {
            const latUrl = `https://api.openaq.org/v3/locations/${loc.id}/latest`;
            const latResp = await fetch(latUrl, { headers: { Accept: 'application/json', 'X-API-Key': OPENAQ_KEY } });
            const latData = await latResp.json();

            let pm25 = null;
            let lastSeen = null;
            for (const r of (latData.results || [])) {
              const pName = r.parameter?.name || '';
              if (pName.toLowerCase().includes('pm25') || pName.toLowerCase().includes('pm2')) {
                pm25 = r.value != null ? +r.value.toFixed(1) : null;
                lastSeen = r.datetime?.local || r.datetime?.utc || null;
              }
            }

            // Only include if data is somewhat recent (within 30 days)
            if (lastSeen) {
              const age = Date.now() - new Date(lastSeen).getTime();
              if (age > 30 * 24 * 60 * 60 * 1000) continue; // skip if older than 30 days
            } else {
              continue; // skip if no timestamp
            }

            const { cat, cls } = pm25Category(pm25);
            const provider = loc.provider?.name || '?';
            if (!foundAny) { results.sources++; foundAny = true; }

            results.stations.push({
              id: `oq-${loc.id}`,
              name: loc.name || `OpenAQ #${loc.id}`,
              source: 'OpenAQ',
              type: `${provider} sensor`,
              lat: loc.coordinates?.latitude,
              lon: loc.coordinates?.longitude,
              pm25,
              aqi: null,
              category: cat,
              cls,
              lastSeen,
              stale: !isRecent(lastSeen),
            });
          } catch (latErr) { /* skip */ }
        }
      } catch (centerErr) { /* skip center */ }
    }
  } catch (e) {
    results.errors = results.errors || [];
    results.errors.push({ source: 'OpenAQ', error: e.message });
  }

  // ── 5. IQAir (last — rate limited, 4 locations) ──
  const iqLocations = [
    { label: 'Denpasar', lat: -8.65, lon: 115.22 },
    { label: 'Ubud', lat: -8.50, lon: 115.26 },
    { label: 'Kerobokan / Seminyak', lat: -8.67, lon: 115.15 },
    { label: 'Jimbaran', lat: -8.79, lon: 115.17 },
  ];

  let iqSuccess = false;
  for (const loc of iqLocations) {
    try {
      const iqUrl = `https://api.airvisual.com/v2/nearest_city?lat=${loc.lat}&lon=${loc.lon}&key=${IQAIR_KEY}`;
      const iqResp = await fetch(iqUrl);
      const iqData = await iqResp.json();
      if (iqData.status === 'success') {
        if (!iqSuccess) { results.sources++; iqSuccess = true; }
        const d = iqData.data;
        const aqi = d.current?.pollution?.aqius;
        const mainPol = d.current?.pollution?.mainus;
        const pm25Est = mainPol === 'p2' ? aqiToPm25(aqi) : null;
        const { cat, cls } = pm25Category(pm25Est != null ? pm25Est : aqiToPm25(aqi));
        const dupeKey = `iq-${d.city}`;
        if (!results.stations.find(s => s.id === dupeKey)) {
          results.stations.push({
            id: dupeKey,
            name: `${loc.label} (${d.city})`,
            source: 'IQAir',
            type: 'Private sensor',
            lat: d.location?.coordinates?.[1],
            lon: d.location?.coordinates?.[0],
            pm25: pm25Est,
            pm25_estimated: mainPol === 'p2',
            aqi,
            category: cat,
            cls,
            lastSeen: d.current?.pollution?.ts || null,
          });
        }
      }
    } catch (e) {
      // IQAir rate limit — skip silently
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  res.status(200).json(results);
}
