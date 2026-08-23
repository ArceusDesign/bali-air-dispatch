/**
 * /api/wind — server-side proxy to Open-Meteo.
 *
 * Privacy purpose: visitors never contact Open-Meteo directly. All requests
 * originate from Cloudflare's edge network, so no visitor IP, referrer, or
 * user-agent leaks to Open-Meteo. The response is cached at the edge for 10
 * minutes, which also trims the request volume we send upstream.
 *
 * Security purpose: the client takes no query parameters. The lat/lon grid is
 * hardcoded to Bali, so a hostile client cannot use this endpoint to proxy
 * arbitrary fetches.
 */

// Bali bounding box. LAT1 is north (top), LAT2 is south (bottom); we iterate
// lat from north → south so the returned array matches the frontend's row
// layout (row 0 = northernmost, row N-1 = southernmost).
const LAT1 = -8.0, LAT2 = -9.0;
const LON1 = 114.4, LON2 = 115.75;
const GRID_N  = 8;   // 8×8 = 64 sample points — plenty for a particle field

function buildBaliGrid() {
  const lats = [], lons = [];
  for (let i = 0; i < GRID_N; i++) {
    const fy = i / (GRID_N - 1);
    const fx = i / (GRID_N - 1);
    // north → south
    lats.push(+(LAT1 - fy * (LAT1 - LAT2)).toFixed(3));
    // west → east
    lons.push(+(LON1 + fx * (LON2 - LON1)).toFixed(3));
  }
  return { lats, lons };
}

export async function onRequestGet() {
  try {
    const grid = buildBaliGrid();

    // Open-Meteo supports comma-separated lat/lon lists → one response per point.
    // We fan out the N×N grid as N² requests, but multiplex them into one upstream
    // call using Open-Meteo's bulk endpoint by listing all lat/lon pairs.
    const allLats = [];
    const allLons = [];
    for (const la of grid.lats) {
      for (const lo of grid.lons) {
        allLats.push(la);
        allLons.push(lo);
      }
    }

    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + allLats.join(',')
      + '&longitude=' + allLons.join(',')
      + '&current=wind_speed_10m,wind_direction_10m'
      + '&wind_speed_unit=ms';

    const upstream = await fetch(url, {
      cf: { cacheTtl: 600, cacheEverything: true }
    });

    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: 'upstream_failed', status: upstream.status }), {
        status: 502,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=600, s-maxage=600',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // '/api/wind' is always fetched relative (see index.html), so this
        // never gates our own site — same-origin requests ignore ACAO
        // entirely regardless of what this header says. Omitted rather than
        // pinned to one domain, and deliberately NOT set to the string
        // "null" — that value matches an Origin: null header, which an
        // attacker can trivially forge from a sandboxed iframe, so it is
        // weaker than sending no header at all. No ACAO header means the
        // browser refuses every cross-origin read by default.
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'proxy_failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
}
