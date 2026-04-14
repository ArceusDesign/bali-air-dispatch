// Vercel Serverless Function — fetches live air quality data server-side
// API keys are stored in Vercel environment variables, never exposed to the browser

export default async function handler(req, res) {
  const PURPLEAIR_KEY = process.env.PURPLEAIR_API_KEY;
  const AQICN_TOKEN = process.env.AQICN_TOKEN;
  const IQAIR_KEY = process.env.IQAIR_API_KEY;

  const results = { ts: new Date().toISOString(), stations: [] };

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
    if (pm <= 12) return { cat: 'Good', cls: 'good' };
    if (pm <= 25) return { cat: 'Moderate', cls: 'mod' };
    if (pm <= 35.4) return { cat: 'Moderate (above WHO 24hr)', cls: 'mod' };
    if (pm <= 55.4) return { cat: 'Unhealthy for Sensitive Groups', cls: 'usg' };
    if (pm <= 150.4) return { cat: 'Unhealthy', cls: 'unh' };
    if (pm <= 250.4) return { cat: 'Very Unhealthy', cls: 'vunh' };
    return { cat: 'Hazardous', cls: 'haz' };
  }

  // ── PurpleAir ──
  try {
    const paUrl = 'https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,pm2.5,last_seen&location_type=0&nwlat=-8.1&nwlng=114.4&selat=-8.85&selng=115.7';
    const paResp = await fetch(paUrl, { headers: { 'X-API-Key': PURPLEAIR_KEY } });
    const paData = await paResp.json();
    if (paData.data) {
      const fields = paData.fields;
      const nameIdx = fields.indexOf('name');
      const pm25Idx = fields.indexOf('pm2.5');
      const latIdx = fields.indexOf('latitude');
      const lonIdx = fields.indexOf('longitude');
      const seenIdx = fields.indexOf('last_seen');

      for (const row of paData.data) {
        const pm = row[pm25Idx];
        const { cat, cls } = pm25Category(pm || 0);
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

  // ── AQICN ──
  try {
    const aqUrl = `https://api.waqi.info/v2/map/bounds?latlng=-8.85,114.4,-8.1,115.7&networks=all&token=${AQICN_TOKEN}`;
    const aqResp = await fetch(aqUrl);
    const aqData = await aqResp.json();
    if (aqData.status === 'ok' && aqData.data) {
      for (const s of aqData.data) {
        // Get detailed data for PM2.5
        try {
          const detUrl = `https://api.waqi.info/feed/@${s.uid}/?token=${AQICN_TOKEN}`;
          const detResp = await fetch(detUrl);
          const detData = await detResp.json();
          const pm25 = detData?.data?.iaqi?.pm25?.v;
          const { cat, cls } = pm25Category(pm25 || 0);
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
        } catch (detErr) {
          // Skip station if detail fetch fails
        }
      }
    }
  } catch (e) {
    results.errors = results.errors || [];
    results.errors.push({ source: 'AQICN', error: e.message });
  }

  // ── IQAir ──
  const iqLocations = [
    { label: 'Denpasar', lat: -8.65, lon: 115.22 },
    { label: 'Ubud', lat: -8.50, lon: 115.26 },
    { label: 'Kerobokan / Seminyak', lat: -8.67, lon: 115.15 },
    { label: 'Jimbaran', lat: -8.79, lon: 115.17 },
  ];

  for (const loc of iqLocations) {
    try {
      const iqUrl = `https://api.airvisual.com/v2/nearest_city?lat=${loc.lat}&lon=${loc.lon}&key=${IQAIR_KEY}`;
      const iqResp = await fetch(iqUrl);
      const iqData = await iqResp.json();
      if (iqData.status === 'success') {
        const d = iqData.data;
        const aqi = d.current?.pollution?.aqius;
        const mainPol = d.current?.pollution?.mainus;
        // Convert AQI to approximate PM2.5 if main pollutant is p2
        const pm25Est = mainPol === 'p2' ? aqiToPm25(aqi) : null;
        const { cat, cls } = pm25Category(pm25Est || aqiToPm25(aqi));
        // Deduplicate — skip if same city already added from same source
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
    // Rate limit buffer
    await new Promise(r => setTimeout(r, 1200));
  }

  res.status(200).json(results);
}
