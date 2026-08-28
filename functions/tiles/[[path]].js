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
// This proxy removed that leak by fetching tiles server-side.
//
// WHY IT NOW READS FROM R2 INSTEAD OF CARTO
// On 26 Aug 2026 CARTO ended keyless access to basemaps.cartocdn.com: every
// anonymous tile request began returning a 200 PNG reading "API KEY REQUIRED",
// cached at their edge for 180 days. Their Basemap T&C §9(c) also explicitly
// forbids "proxying or caching the content on the server side" — i.e. this
// file — so obtaining a free key would not have made the architecture
// compliant, and a key is revocable at their sole discretion without notice.
//
// The basemap is therefore now OURS: OpenStreetMap data (ODbL), rendered to
// raster PNGs with CARTO's own open-source Voyager style (BSD-3 code /
// CC-BY design — the STYLE is open even though their tile SERVICE is not),
// via Planetiler + MapLibre GL Native, and stored in R2 as ~68k tiles /
// ~136k objects. See scripts/basemap/ in this repo for the build pipeline.
//
// The privacy property is now absolute rather than merely mediated: there is
// no third party in the request path at all, so there is no upstream that
// could log, rate-limit, gate, or withdraw anything. Attribution for OSM,
// OpenMapTiles and CARTO's design is carried in the page UI, per those licences.
//
// THE RISK THIS FILE HAS TO MANAGE
// A tile endpoint is a key builder driven by strangers. The rule enforced below
// is absolute and unchanged from the CARTO era: the object key is assembled
// from three JavaScript integers and one boolean — never from any string the
// caller supplied. A caller cannot influence the bucket, the prefix or the
// extension; they can only nudge three numbers, and those numbers are
// range-checked against the area the map can actually display. Serving from R2
// strictly shrinks this surface — there is no longer any outbound fetch, so
// SSRF is not merely blocked but structurally impossible — while the same
// validation still bounds which of our own ~136k objects are reachable.
//
// CACHING
// Pages Functions responses do NOT pass through the CDN cache on their own
// (see the long note in functions/api/v1/[[path]].js — measured: no response
// ever carried cf-cache-status, so Cache-Control alone is decorative). Without
// an explicit cache every pan of every visitor would be a fresh R2 read: still
// correct, but a Class B operation per tile per visitor when one edge-cached
// copy would serve the whole colo. caches.default is used directly, keyed on a
// canonical path we rebuild ourselves.
// ─────────────────────────────────────────────────────────────────────────────

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

// A voyager tile is ~10-70 KB (@2x). A megabyte is far past anything real and
// stops a surprise object from being buffered into memory wholesale.
const MAX_TILE_BYTES = 1024 * 1024;

// Canonical decimal integer, no leading zeros, no sign, no whitespace, no
// exponent — so exactly one URL string maps to any given tile. Without the
// no-leading-zeros rule, /tiles/09/0418/267.png and /tiles/9/418/267.png are
// different cache entries for the same image, and the "finite tile set" that
// bounds this endpoint's cost stops being finite.
const INT_RE = /^(?:0|[1-9][0-9]{0,6})$/;
const toInt = (s) => (INT_RE.test(s) ? Number(s) : null);

// Errors are cached at the EDGE for a minute — long enough that an R2 incident
// or a scripted sweep of unservable tiles collapses into roughly one origin
// read per tile per colo per minute instead of one per visitor request, and
// short enough that a recovered tile appears almost immediately. max-age=0
// keeps it out of browser caches, so a visitor who retries is never the one
// holding the stale failure. Not applied to 405/404-shaped *validation*
// rejections, which never touch R2 and cost nothing to recompute.
const NEGATIVE_TTL_S = 60;
function originFail(status, message) {
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
  const { request, params, waitUntil, env } = context;

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
  // amplifier that forwards every one of those misses to the origin.
  //
  // TILESET_EPOCH participates in the cache key ONLY (never in a public URL or
  // an R2 key). Tiles are served `immutable` with s-maxage=30d, so when the
  // BYTES behind a coordinate change, every previously-cached entry is a stale
  // wrong answer that no amount of waiting for a deploy will clear. That is not
  // hypothetical: the CARTO→R2 cutover left "API KEY REQUIRED" placeholders
  // pinned at the edge for precisely the tiles readers look at most, since
  // those are the ones that were cached. Bumping this orphans every old entry
  // atomically and costs one re-read per tile per colo.
  //
  // BUMP THIS whenever the tileset is re-rendered (see scripts/basemap/).
  const TILESET_EPOCH = '2026-08-27';
  const canonical = `/tiles/${TILESET_EPOCH}/${z}/${x}/${y}${retina ? '@2x' : ''}.png`;
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

  // ── read from R2 ───────────────────────────────────────────────────────────
  // Assembled from numbers and a boolean only. There is no interpolation of
  // caller-supplied text anywhere in this key, so no traversal and no prefix
  // escape is expressible. No network fetch happens here at all: the bytes
  // come from our own bucket over Cloudflare's internal binding, so there is
  // no upstream that could observe the request, and nothing to time out on a
  // third party's behalf.
  const key = `${z}/${x}/${y}${retina ? '@2x' : ''}.png`;

  const bucket = env && env.TILES;
  if (!bucket) {
    // Misconfiguration (binding absent), not a caller error — and emphatically
    // not cacheable, or one bad deploy pins a blank map at the edge.
    console.error('tiles: R2 binding TILES missing');
    return textFail(500, 'Basemap temporarily unavailable.');
  }

  let obj;
  try {
    obj = await bucket.get(key);
  } catch (err) {
    console.error('tiles: R2 get failed', z, x, y, err && err.message);
    return originFail(502, 'Basemap tile unavailable.');
  }

  if (!obj) {
    // A key inside the authorised window that has no object behind it means an
    // incomplete upload, not a hostile request — 404 so the map shows a hole
    // rather than an error, and log it so the gap is findable.
    console.error('tiles: R2 object missing', key);
    return originFail(404, 'Basemap tile unavailable.');
  }

  // R2 reports the stored length up front, so an implausible object is
  // rejected before its body is pulled into memory.
  if (Number.isFinite(obj.size) && obj.size > MAX_TILE_BYTES) {
    console.error('tiles: R2 object too large', key, obj.size);
    return originFail(502, 'Basemap tile unavailable.');
  }

  let body;
  try {
    body = await obj.arrayBuffer();
  } catch (err) {
    console.error('tiles: R2 body read failed', z, x, y, err && err.message);
    return originFail(502, 'Basemap tile unavailable.');
  }
  if (body.byteLength > MAX_TILE_BYTES) {
    return originFail(502, 'Basemap tile unavailable.');
  }
  // Kept from the CARTO-era code even though we now write these objects
  // ourselves: it is the check that stops a truncated or half-written upload
  // being cached under `immutable` for a month, pinning a broken square on the
  // map. Cheap, and the failure it guards against is one we can actually cause.
  const sig = new Uint8Array(body, 0, Math.min(8, body.byteLength));
  const isPng = sig.length >= 8 && sig[0] === 0x89 && sig[1] === 0x50 &&
                sig[2] === 0x4e && sig[3] === 0x47 && sig[4] === 0x0d &&
                sig[5] === 0x0a && sig[6] === 0x1a && sig[7] === 0x0a;
  if (!isPng || body.byteLength < 67) {
    console.error('tiles: R2 object not a PNG', key, body.byteLength);
    return originFail(502, 'Basemap tile unavailable.');
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
