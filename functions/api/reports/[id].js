// Cloudflare Pages Function — proxies a single Making Sense Bali report photo.
// Never hot-link: a visitor's browser must never talk to github.io directly,
// or every popup-open on our anonymous map leaks that visitor's IP to a third
// party this project doesn't control. See functions/api/reports.js for the
// feed this serves and why the two validation layers below exist.
const MSB_BASE = 'https://mdg-bali.github.io/makingsensebali/data/';
// Shape-tolerant by design — see the matching note in functions/api/reports.js.
// Upstream re-keyed every filename once already (v3, 15 Aug 2026); what matters
// for safety is that the id cannot escape the URL path, not its exact layout.
const ID_RE = /^AQ_\d{8}_[A-Za-z0-9_]{1,32}$/;
const PHOTO_PATH_RE = /^photos\/[A-Za-z0-9_]+\.jpg$/;
const TEST_JUNK_RE = /\btest\b|do not approve|safe to reject|safe to ignore|auto-?rejected|smoke test/i;
const UPSTREAM_TIMEOUT_MS = 8000;
// Deliberately SHORT, and deliberately not `immutable`. The photo is the most
// identifying artifact this feature touches, and upstream removes reports when
// a resident revokes consent. A long TTL would keep serving a withdrawn photo
// from our own edge — and from every visitor's browser cache — long after it
// was pulled at the source, with no invalidation path. 15 min bounds that to
// roughly one archive tick. (The report JSON is re-checked on every miss, so
// scope changes propagate on the same cadence.)
const PHOTO_TTL_S = 900;

export async function onRequestGet({ params, waitUntil }) {
  const id = String(params.id || '');
  // Validated against the exact observed filename shape before it's ever used
  // to build an upstream URL — this id ultimately comes from a third party's
  // index, not from our own data, so it's treated as untrusted input.
  if (!ID_RE.test(id)) return new Response('Not found', { status: 404 });

  const cache = caches.default;
  const cacheKey = new Request('https://reports.internal/photo/' + id, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let report;
  try {
    const r = await fetch(MSB_BASE + 'reports/' + id + '.json', {
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!r.ok) return new Response('Not found', { status: 404 });
    report = await r.json();
  } catch (_) {
    return new Response('Not found', { status: 404 });
  }

  // Scope this proxy to exactly what the map is allowed to show — a burning,
  // active, non-junk report — not "fetch any photo Making Sense Bali hosts."
  if (!report || report.pollution_category !== 'burning' || report.status !== 'active') {
    return new Response('Not found', { status: 404 });
  }
  const text = [report.description, report.name].filter(Boolean).join(' ');
  if (TEST_JUNK_RE.test(text)) return new Response('Not found', { status: 404 });

  const photoPath = report.photo_path;
  if (!photoPath || !PHOTO_PATH_RE.test(photoPath)) return new Response('Not found', { status: 404 });

  let photo;
  try {
    photo = await fetch(MSB_BASE + 'reports/' + photoPath, {
      cf: { cacheTtl: PHOTO_TTL_S, cacheEverything: true },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (_) {
    return new Response('Not found', { status: 404 });
  }
  if (!photo.ok) return new Response('Not found', { status: 404 });

  const res = new Response(photo.body, {
    status: 200,
    headers: {
      // Content-Type is FORCED, not passed through from upstream: PHOTO_PATH_RE
      // has already established this is a .jpg, and echoing a third party's
      // header would let them serve something else under our origin. Paired
      // with nosniff because public/_headers does not apply to Functions.
      'Content-Type': 'image/jpeg',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': `public, max-age=${PHOTO_TTL_S}`,
    },
  });
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
