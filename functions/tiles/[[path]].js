// ─────────────────────────────────────────────────────────────────────────────
// Bali Air Dispatch — first-party basemap tile proxy
//
//   GET /tiles/{z}/{x}/{y}.png
//   GET /tiles/{z}/{x}/{y}@2x.png     ← Leaflet's {r} retina suffix
//
// WHY THIS EXISTS
// The map used to load basemap tiles straight from *.basemaps.cartocdn.com, so
// every visitor's IP reached CARTO together with the exact tiles they asked
// for — which is a quantised copy of wherever that person is looking. On a site
// whose whole promise is "no trackers, no accounts, circulated anonymously",
// that was the one remaining place a reader's location leaked to a third party.
// Routed through here, CARTO sees Cloudflare fetching a tile and nothing else:
// no IP, no User-Agent, no Referer, no cookies, no Accept-Language.
//
// THE RISK THIS FILE HAS TO MANAGE
// A tile proxy is a URL builder driven by strangers, i.e. an SSRF/open-proxy
// waiting to happen. The rule enforced below is absolute: the upstream URL is
// assembled from two JavaScript integers, one integer and one boolean — never
// from any string the caller supplied. A caller cannot influence the host, the
// scheme, the path prefix or the extension; they can only nudge three numbers,
// and those numbers are range-checked against the area the map can actually
// display. So this is not a proxy for CARTO; it is a proxy for ~68k specific
// tiles (136k URLs — every tile also has an @2x variant with its own cache key
// and its own upstream fetch, and Leaflet requests @2x on retina screens)
// tiles covering Bali, and nothing else on Earth is reachable through it.
//
// CACHING
// Pages Functions responses do NOT pass through the CDN cache on their own
// (see the long note in functions/api/v1/[[path]].js — measured: no response
// ever carried cf-cache-status, so Cache-Control alone is decorative). Without
// an explicit cache every pan of every visitor would be a fresh CARTO fetch,
// which is both slow and rude to a free basemap. caches.default is used
// directly, keyed on a canonical path we rebuild ourselves.
// ─────────────────────────────────────────────────────────────────────────────

// Upstream. Bare host rather than the {s}.basemaps… sharded form: subdomain
// sharding exists to work around HTTP/1.1 connection limits in browsers and is
// pointless for a server-side fetch over HTTP/2. Verified 200 + image/png with
// zero redirects on both the plain and the @2x path.
const UPSTREAM_ORIGIN = 'https://basemaps.cartocdn.com';
const UPSTREAM_STYLE = '/rastertiles/voyager';

// The map's real zoom range — public/index.html: L.map(..., minZoom:9, maxZoom:16).
// Anything outside this is not a tile our own map can ever request.
const MIN_Z = 9;
const MAX_Z = 16;

// The map's bounds — public/index.html: L.latLngBounds([-8.92,114.35],[-8.00,115.75])
// used as maxBounds via .pad(0.02) with maxBoundsViscosity 1.0.
// Keep in sync with BALI there; these two definitions are the same fact.
const BALI = { south: -8.92, west: 114.35, north: -8.00, east: 115.75 };
const BOUNDS_PAD = 0.02;   // matches Leaflet's LatLngBounds.pad(0.02)

const TILE_PX = 256;
// maxBounds stops a visitor panning past the island, but it cannot stop them
// SEEING past it: when the viewport is wider than the bounds — which at z9 it
// always is, the padded box being ~3 tiles across — Leaflet centres the map and
// the sea, Java and Lombok fill the rest of the window. Those tiles are part of
// our own map's honest field of view, so the allowed range is the padded box
// plus exactly the overscan a viewport of this size can reveal, and no more.
// Deliberately expressed as pixels: overscan is a screen-size fact, so it costs
// many tiles at z9 (where the island is small on screen) and almost none from
// z12 up (where the bounds already exceed any viewport and panning is pinned).
const MAX_VIEWPORT_PX = 4096;  // covers 4K fullscreen; beyond that, edge tiles 404
const SLACK_TILES = 2;         // fractional-zoom rounding + Leaflet's keepBuffer

// Standard slippy-map / Web-Mercator tile maths (OSM "Slippy map tilenames").
const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

// Tiles of overscan to allow either side of a span that is `spanTiles` wide.
const overscanTiles = (spanTiles) =>
  Math.ceil(Math.max(0, (MAX_VIEWPORT_PX - spanTiles * TILE_PX) / 2) / TILE_PX) + SLACK_TILES;

// Allowed x/y window per zoom, DERIVED from the bounding box — never a
// hardcoded table, so moving BALI above moves the permitted tiles with it.
// Computed once per isolate; it is eight iterations of trivial arithmetic.
//
//   z= 9  x   409..429    y   258..277        420 tiles
//   z=10  x   829..849    y   526..545        420
//   z=11  x  1668..1688   y  1062..1082       441
//   z=12  x  3346..3367   y  2135..2154       440
//   z=13  x  6695..6732   y  4276..4302     1,026
//   z=14  x 13392..13463  y  8554..8602     3,528
//   z=15  x 26787..26924  y 17110..17202   12,834
//   z=16  x 53577..53846  y 34223..34403   48,870
//                                    total ~68k tiles / ~136k URLs with @2x.
//   Finite, but caches.default is PER-COLO, so a crawler spread across
//   datacentres multiplies upstream fetches by the number of colos it reaches.
//   The short negative cache below blunts the failure case; a Cloudflare Rate
//   Limiting rule on /tiles/* is the real ceiling and is configured outside
//   this repo.
const ALLOWED = (() => {
  const latPad = Math.abs(BALI.south - BALI.north) * BOUNDS_PAD;
  const lonPad = Math.abs(BALI.west - BALI.east) * BOUNDS_PAD;
  const south = BALI.south - latPad, north = BALI.north + latPad;
  const west = BALI.west - lonPad, east = BALI.east + lonPad;

  const table = new Map();
  for (let z = MIN_Z; z <= MAX_Z; z++) {
    const n = 2 ** z;
    // y grows southward in Web Mercator, so the NORTH edge gives the low y.
    const coreX0 = lonToX(west, z), coreX1 = lonToX(east, z);
    const coreY0 = latToY(north, z), coreY1 = latToY(south, z);
    const mx = overscanTiles(coreX1 - coreX0 + 1);
    const my = overscanTiles(coreY1 - coreY0 + 1);
    table.set(z, {
      x0: Math.max(0, coreX0 - mx), x1: Math.min(n - 1, coreX1 + mx),
      y0: Math.max(0, coreY0 - my), y1: Math.min(n - 1, coreY1 + my),
    });
  }
  return table;
})();

const UPSTREAM_TIMEOUT_MS = 6000;
// A voyager tile is ~10-70 KB (@2x). A megabyte is far past anything real and
// stops a surprise upstream response from being buffered into memory wholesale.
const MAX_TILE_BYTES = 1024 * 1024;

// Canonical decimal integer, no leading zeros, no sign, no whitespace, no
// exponent — so exactly one URL string maps to any given tile. Without the
// no-leading-zeros rule, /tiles/09/0418/267.png and /tiles/9/418/267.png are
// different cache entries for the same image, and the "finite tile set" that
// bounds this endpoint's cost stops being finite.
const INT_RE = /^(?:0|[1-9][0-9]{0,6})$/;
const toInt = (s) => (INT_RE.test(s) ? Number(s) : null);

// Errors are cached at the EDGE for a minute — long enough that a CARTO outage
// or a scripted sweep of unservable tiles collapses into roughly one upstream
// request per tile per colo per minute instead of one per visitor request, and
// short enough that a recovered tile appears almost immediately. max-age=0
// keeps it out of browser caches, so a visitor who retries is never the one
// holding the stale failure. Not applied to 405/404-shaped *validation*
// rejections, which never touch upstream and cost nothing to recompute.
const NEGATIVE_TTL_S = 60;
function upstreamFail(status, message) {
  return textFail(status, message, {
    'Cache-Control': `public, max-age=0, s-maxage=${NEGATIVE_TTL_S}`,
  });
}

function textFail(status, message, extraHeaders) {
  return new Response(message + '\n', {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Errors must never inherit the tile cache policy; a transient upstream
      // failure otherwise pins a hole in the map for a month.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(extraHeaders || {}),
    },
  });
}

export async function onRequest(context) {
  const { request, params, waitUntil } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textFail(405, 'Method not allowed. Tiles are read-only.', { Allow: 'GET, HEAD' });
  }

  // ── parse ──────────────────────────────────────────────────────────────────
  const segs = Array.isArray(params.path) ? params.path.filter(Boolean)
             : (params.path ? [params.path] : []);
  if (segs.length !== 3) {
    return textFail(404, 'Not found. Expected /tiles/{z}/{x}/{y}.png');
  }
  // The leaf carries the extension and Leaflet's optional retina marker. The
  // regex is the only place a caller's string is inspected, and nothing from it
  // survives into the upstream URL — only the captured digits (re-parsed as a
  // number) and whether the "@2x" group matched.
  const leaf = /^(0|[1-9][0-9]{0,6})(@2x)?\.png$/.exec(segs[2]);
  if (!leaf) return textFail(404, 'Not found. Expected /tiles/{z}/{x}/{y}.png');

  const z = toInt(segs[0]);
  const x = toInt(segs[1]);
  const y = toInt(leaf[1]);
  const retina = leaf[2] !== undefined;

  if (z === null || x === null || y === null ||
      !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return textFail(404, 'Not found. z, x and y must be integers.');
  }

  // ── authorise: zoom, then the tile window this bbox covers at that zoom ─────
  const win = ALLOWED.get(z);   // Map lookup doubles as the MIN_Z..MAX_Z check
  if (!win) {
    return textFail(404, `Not found. Zoom must be ${MIN_Z}-${MAX_Z}.`);
  }
  if (x < win.x0 || x > win.x1 || y < win.y0 || y > win.y1) {
    // Out of area. This is the case that keeps the endpoint from being a free
    // basemap CDN for the rest of the planet: London at z13 is x=4093 y=2724
    // against an allowed 6695..6732 / 4276..4302, so it lands here.
    return textFail(404, 'Not found. Tile is outside the Bali coverage area.');
  }

  // ── cache ──────────────────────────────────────────────────────────────────
  // Key rebuilt from the validated numbers rather than taken from request.url.
  // That drops the query string, which matters: `?bust=1`, `?bust=2`, … would
  // otherwise be unlimited distinct keys for one image, turning a cache into an
  // amplifier that forwards every one of those misses to CARTO.
  const canonical = `/tiles/${z}/${x}/${y}${retina ? '@2x' : ''}.png`;
  const cacheUrl = new URL(request.url).origin + canonical;
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    // Deliberately NO X-Cache header. caches.default is shared by everyone in a
    // Cloudflare colo and entries live a month, so a HIT/MISS flag would have
    // been a free, noise-free oracle: sweep the ~1k z13 tiles and read off
    // exactly which parts of Bali this site's readers have looked at — and
    // since locate-me centres the map on the visitor, some of those are where
    // a reader physically was. A timing difference remains but needs many
    // samples; the header needed one request.
    const headers = new Headers(hit.headers);
    // A HEAD must not carry a body; the cache only ever holds GET responses.
    return new Response(request.method === 'HEAD' ? null : hit.body, { status: hit.status, headers });
  }

  // ── fetch upstream ─────────────────────────────────────────────────────────
  // Assembled from numbers and a boolean only. There is no interpolation of
  // caller-supplied text anywhere in this string, so no traversal, no host
  // switch, no protocol switch is expressible.
  const upstream = `${UPSTREAM_ORIGIN}${UPSTREAM_STYLE}/${z}/${x}/${y}${retina ? '@2x' : ''}.png`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(upstream, {
      method: 'GET',
      // Constructed header set, NOT a copy of the visitor's request. This is
      // the privacy guarantee of the whole file: no IP, no User-Agent from the
      // browser, no Referer, no Cookie, no Accept-Language, no Sec-CH-* hints.
      //
      // No project-identifying User-Agent either. A named UA would have been
      // the courteous choice, but the site is published anonymously and the
      // browser already sends Referrer-Policy: no-referrer, so before this
      // proxy existed CARTO could not attribute the traffic to the project at
      // all. Naming ourselves here from a stable egress would have handed them
      // a durable, volume-measurable record of it — moving operator anonymity
      // backwards in the same change that improved visitor privacy.
      headers: { 'Accept': 'image/png' },
      // Never chase a 3xx: a redirect is the one way an upstream could still
      // point this fetch at a host we never authorised. A redirect is treated
      // as a failure instead.
      redirect: 'manual',
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    console.error('tiles: upstream fetch failed', z, x, y, err && err.message);
    return upstreamFail(504, 'Basemap tile temporarily unavailable.');
  }
  clearTimeout(timer);

  if (res.status !== 200) {
    console.error('tiles: upstream status', res.status, z, x, y);
    // 404 from CARTO stays a 404 (a real hole in their coverage); anything
    // else — including a redirect we refused to follow — is our problem, 502.
    return upstreamFail(res.status === 404 ? 404 : 502, 'Basemap tile unavailable.');
  }

  const type = (res.headers.get('Content-Type') || '').toLowerCase();
  // PNG specifically, not image/* — this endpoint only ever asks for .png, and
  // image/svg+xml passes an "image/" test while being a scriptable document.
  // Served from our own origin, an SVG carrying inline script would execute as
  // baliair.pages.dev and our CSP allows 'unsafe-inline', so the prefix test
  // would have been an XSS vector rather than a safety net.
  if (type !== 'image/png' && !type.startsWith('image/png;')) {
    console.error('tiles: upstream content-type', type, z, x, y);
    return upstreamFail(502, 'Basemap tile unavailable.');
  }

  const declared = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_TILE_BYTES) {
    return upstreamFail(502, 'Basemap tile unavailable.');
  }
  // Inside try/catch: headers can arrive and the body still fail — a reset or
  // a truncated HTTP/2 stream mid-tile is an ordinary upstream event. Left
  // unguarded the rejection escapes onRequest and Pages serves its generic 500,
  // which carries none of textFail()'s no-store/nosniff guarantees.
  let body;
  try {
    body = await res.arrayBuffer();
  } catch (err) {
    console.error('tiles: upstream body read failed', z, x, y, err && err.message);
    return upstreamFail(502, 'Basemap tile unavailable.');
  }
  if (body.byteLength > MAX_TILE_BYTES) {
    return upstreamFail(502, 'Basemap tile unavailable.');
  }
  // A 200 with an empty or truncated body is not a tile. Without this a clean
  // END_STREAM after a partial write — which does not throw — got cached under
  // `immutable` for a month, pinning a broken square on the map long after
  // upstream recovered. Check the PNG signature rather than just the length.
  const sig = new Uint8Array(body, 0, Math.min(8, body.byteLength));
  const isPng = sig.length >= 8 && sig[0] === 0x89 && sig[1] === 0x50 &&
                sig[2] === 0x4e && sig[3] === 0x47 && sig[4] === 0x0d &&
                sig[5] === 0x0a && sig[6] === 0x1a && sig[7] === 0x0a;
  if (!isPng || body.byteLength < 67) {
    console.error('tiles: upstream body not a PNG', z, x, y, body.byteLength);
    return upstreamFail(502, 'Basemap tile unavailable.');
  }
  if (Number.isFinite(declared) && declared > 0 && declared !== body.byteLength) {
    console.error('tiles: upstream length mismatch', z, x, y, declared, body.byteLength);
    return upstreamFail(502, 'Basemap tile unavailable.');
  }

  // Buffered rather than streamed on purpose: a tile is tens of kilobytes, and
  // holding it lets the response and the cache copy be built independently
  // instead of tee-ing one stream and hoping both ends drain.
  const headers = new Headers({
    // Only the media type crosses over from upstream; every other upstream
    // header (ETag, Vary, ACAO, Server, x-origin-server…) is dropped, both to
    // avoid leaking their infrastructure detail and to keep this response
    // entirely ours.
    // Hardcoded, never echoed from upstream — see the PNG check above.
    'Content-Type': 'image/png',
    // Basemap tiles are effectively static — CARTO themselves send
    // max-age=15552000 (180 days). A week in the browser, a month at the edge.
    'Cache-Control': 'public, max-age=604800, s-maxage=2592000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // We are the only legitimate consumer; this stops other origins embedding
    // our proxy as their basemap.
    'Cross-Origin-Resource-Policy': 'same-origin',
  });

  const stored = new Response(body, { status: 200, headers });
  if (typeof waitUntil === 'function') {
    // .catch() rather than only try/catch: cache.put returns a promise, so a
    // rejection (an entry the cache declines, a size limit) arrives after this
    // frame and would surface as an unhandled rejection against an invocation
    // that already served the tile perfectly well. Caching is best-effort.
    try { waitUntil(cache.put(cacheKey, stored.clone()).catch(() => {})); } catch (_) { /* best effort */ }
  }
  return request.method === 'HEAD'
    ? new Response(null, { status: 200, headers })
    : stored;
}
