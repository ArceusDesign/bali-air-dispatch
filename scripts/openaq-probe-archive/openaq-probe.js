// TEMPORARY probe — lists ALL OpenAQ locations in Bali (active + inactive),
// returns metadata + sensor IDs + date ranges. Delete after investigation.

export async function onRequest(context) {
  const KEY = context.env.OPENAQ_API_KEY;
  const H = { Accept: 'application/json', 'X-API-Key': KEY };

  // Bali bbox: lat -8.1 to -8.85, lon 114.4 to 115.7
  // Use bbox query on v3/locations. v3 supports bbox=west,south,east,north
  const bbox = '114.4,-8.85,115.7,-8.1';

  const out = { ts: new Date().toISOString(), bbox, locations: [], errors: [] };

  try {
    // Paginate through all locations in Bali (active + inactive)
    let page = 1;
    const limit = 100;
    while (page <= 10) {
      const url = `https://api.openaq.org/v3/locations?bbox=${bbox}&limit=${limit}&page=${page}`;
      const r = await fetch(url, { headers: H });
      const d = await r.json();
      const results = d.results || [];
      for (const loc of results) {
        // extract sensor summary
        const sensors = (loc.sensors || []).map(s => ({
          id: s.id,
          name: s.name,
          parameter: s.parameter?.name || null,
          units: s.parameter?.units || null,
        }));
        out.locations.push({
          id: loc.id,
          name: loc.name,
          locality: loc.locality,
          country: loc.country?.code,
          coords: loc.coordinates,
          provider: loc.provider?.name,
          owner: loc.owner?.name,
          isMonitor: loc.isMonitor,
          isMobile: loc.isMobile,
          datetimeFirst: loc.datetimeFirst?.utc || null,
          datetimeLast: loc.datetimeLast?.utc || null,
          sensors,
        });
      }
      if (results.length < limit) break;
      page++;
    }
  } catch (e) {
    out.errors.push({ step: 'list-locations', error: e.message });
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
