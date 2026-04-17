// TEMPORARY probe — fetches full daily pm25 history for each Bali OpenAQ sensor.
// Uses /v3/sensors/{id}/measurements/daily with pagination.
// Delete after investigation.

export async function onRequest(context) {
  const KEY = context.env.OPENAQ_API_KEY;
  const H = { Accept: 'application/json', 'X-API-Key': KEY };

  const sensors = [
    { locId: 4826556, locName: 'Ubud',      owner: 'Rozendal',    pm25SensorId: 13397855, first: '2025-06-22', last: '2025-12-05' },
    { locId: 5044494, locName: 'Balangan',  owner: 'AirGradient', pm25SensorId: 13577847, first: '2025-07-12', last: '2025-08-06' },
    { locId: 6103913, locName: 'Kopernik',  owner: 'AirGradient', pm25SensorId: 14439936, first: '2025-10-22', last: '2026-03-02' },
    { locId: 6103954, locName: 'Kopernik2', owner: 'AirGradient', pm25SensorId: 14440231, first: '2025-10-22', last: '2026-03-02' },
  ];

  const out = { ts: new Date().toISOString(), stations: [] };

  for (const s of sensors) {
    const station = { ...s, daily: [], errors: [] };
    try {
      // Paginate daily aggregates (up to 1000 per page)
      let page = 1;
      while (page <= 5) {
        const url = `https://api.openaq.org/v3/sensors/${s.pm25SensorId}/measurements/daily?limit=1000&page=${page}&date_from=${s.first}&date_to=2026-04-18`;
        const r = await fetch(url, { headers: H });
        if (!r.ok) {
          station.errors.push({ page, status: r.status, text: await r.text() });
          break;
        }
        const d = await r.json();
        const results = d.results || [];
        for (const row of results) {
          station.daily.push({
            date: row.period?.datetimeFrom?.local?.slice(0, 10) || row.period?.datetimeFrom?.utc?.slice(0, 10),
            value: row.value,
            count: row.coverage?.observedCount,
            expected: row.coverage?.expectedCount,
          });
        }
        if (results.length < 1000) break;
        page++;
      }
    } catch (e) {
      station.errors.push({ step: 'fetch', error: e.message });
    }
    out.stations.push(station);
  }

  return new Response(JSON.stringify(out), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
