// Cloudflare Pages Function — proxies Making Sense Bali's community air-quality
// reports feed (github.io static JSON) for the map's burning-event overlay.
// Third-party feed: https://mdg-bali.github.io/makingsensebali/data/
// Contact: Tomas Diez — tomas@fab.city. Licence: CC BY 4.0, attribution required
// ("Data: Making Sense Bali", linked). See public/index.html attribution control.
//
// Only pollution_category "burning" is in scope — the upstream feed carries
// other event types (trash, vehicle, construction, "none") we don't display.
//
// ─── WHY THIS FILE IS DEFENSIVE ────────────────────────────────────────────
// Upstream documents three guarantees that its live data does not honour
// (all verified directly against the feed, 2026-08-14). We therefore trust
// none of them and re-impose each one here:
//
//  1. "Reviewed by a human moderator before publication" — the feed published
//     a record reading "Test Telegram bot - do not approve." with
//     status:"active" and pollution_category:"burning", and three further test
//     records appeared within hours of us reporting it. → TEST_JUNK_RE.
//  2. "Coordinates are neighbourhood-level, not exact addresses — that's
//     deliberate" — live coordinates are 7-decimal (building-level), and one
//     reporter's 11 reports all land on a single exact point, identifying a
//     specific property and, by inference, the neighbour reporting it.
//     → snap() to a ~275 m grid. We never publish upstream precision.
//  3. "No names, no phone numbers... What's published is already scrubbed" —
//     9 of 30 live burning descriptions carry street names, named businesses,
//     named markets, or self-identifying text ("a recycling center next to our
//     house who is daily burning trash. I chatted with them today"). Publishing
//     that beside a map pin re-identifies what snap() just protected, and this
//     site is deliberately amplified to media. → the resident's free-text
//     `description` is NOT published and NOT archived. We publish upstream's
//     model-generated `ai_analysis.description` instead, which is scene text
//     ("smoke rising from a pile of trash") and carries no addresses or names.
//     If upstream ever scrubs descriptions properly this can be revisited.
const MSB_BASE = 'https://mdg-bali.github.io/makingsensebali/data/';
const REPORT_MAX_AGE_DAYS = 30;
const GRID_DEG = 0.0025; // ~275 m at Bali's latitude — collapses exact points
                         // to a neighbourhood cell, and usefully re-clusters
                         // repeat reports of the same site into one dot.
                         // (index.html groups by cell so they don't stack.)
const ID_RE = /^AQ_\d{8}_\d{6}_\d{3}$/; // exact shape of every filename observed;
                                        // validated BEFORE it's used to build any
                                        // upstream URL — never trust the index
                                        // blindly, even though it's not user input.
const TEST_JUNK_RE = /\btest\b|do not approve|safe to reject|safe to ignore|auto-?rejected|smoke test/i;

// Hard ceiling on upstream fan-out per cache miss. Cloudflare caps subrequests
// per invocation at 50 (Free) / 1000 (Paid); we must stay under the lower one.
// The date pre-filter below already bounds this to the reports actually inside
// the window (29 today), but the index is third-party-controlled and anyone can
// add entries to it, so an explicit cap is the thing that actually holds.
const MAX_FETCH = 40;
const UPSTREAM_TIMEOUT_MS = 8000;  // no un-bounded third-party fetches: the
                                   // archive worker calls this endpoint ahead
                                   // of the IQAir watchdog, so a hung upstream
                                   // connection must not stall that worker.

function snap(v) {
  // Round-trip through toFixed to kill float noise from the division
  // (0.0025 isn't exactly representable) — e.g. -8.665000000000001.
  return +(Math.round(v / GRID_DEG) * GRID_DEG).toFixed(4);
}

function isJunk(r) {
  const text = [r && r.description, r && r.name].filter((x) => typeof x === 'string').join(' ');
  return TEST_JUNK_RE.test(text);
}

async function fetchJSON(url) {
  // Every failure mode collapses to null: network rejection, "Too many
  // subrequests", timeout, non-2xx, or unparseable body. Callers count nulls
  // rather than treating them as "no data" (see `partial` below).
  try {
    const r = await fetch(url, {
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

// YYYYMMDD embedded in the filename, used to bound the fan-out BEFORE fetching.
// Verified against the live feed: date_added is always >= the filename stamp
// (max drift ~10 h), so a 2-day pad cannot exclude an in-window report.
function ymdFromId(id) {
  return id.slice(3, 11);
}

export async function onRequestGet({ request, waitUntil }) {
  // Cache key is a CONSTANT internal URL, not request.url: this endpoint
  // ignores query strings entirely, so keying on them would let anyone bypass
  // the cache with ?x=1,2,3… and force an unbounded upstream fan-out per hit.
  const cache = caches.default;
  const cacheKey = new Request('https://reports.internal/api/reports', { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set('X-Cache', 'HIT');
    return r;
  }

  const nowMs = Date.now();
  const cutoffMs = nowMs - REPORT_MAX_AGE_DAYS * 86400000;
  let reports = [];
  let failed = 0;
  let attempted = 0;
  let indexOk = false;

  try {
    const idx = await fetchJSON(MSB_BASE + 'reports/index.json');
    const profiles = Array.isArray(idx && idx.profiles) ? idx.profiles : [];
    indexOk = profiles.length > 0;

    if (indexOk) {
      const padMs = 2 * 86400000;
      const cutoffYmd = new Date(cutoffMs - padMs).toISOString().slice(0, 10).replace(/-/g, '');
      const ids = profiles
        .map((p) => String(p).replace(/\.json$/, ''))
        .filter((id) => ID_RE.test(id) && ymdFromId(id) >= cutoffYmd)
        // Newest first, so if the cap ever bites it drops the STALEST rows.
        // The upstream index is append-only ascending, so without this a
        // truncation would silently delete exactly the freshest reports.
        .sort()
        .reverse()
        .slice(0, MAX_FETCH);
      attempted = ids.length;

      const settled = await Promise.all(
        ids.map((id) => fetchJSON(MSB_BASE + 'reports/' + id + '.json').then((r) => [id, r]))
      );

      for (const [id, r] of settled) {
        if (!r) { failed++; continue; }
        try {
          if (r.pollution_category !== 'burning' || r.status !== 'active') continue;
          if (isJunk(r)) continue;
          const lat = +r.latitude, lon = +r.longitude;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const addedMs = typeof r.date_added === 'string' ? Date.parse(r.date_added) : NaN;
          if (!Number.isFinite(addedMs) || addedMs < cutoffMs) continue;
          // Future-dated records would sit at age 0 forever — permanently the
          // brightest, glowing dot on the map, and trivially self-assigned by
          // anyone submitting a report. Allow only a little clock skew.
          if (addedMs > nowMs + 3600000) continue;

          const ai = r.ai_analysis || {};
          reports.push({
            id,
            lat: snap(lat),
            lon: snap(lon),
            date_added: r.date_added,
            age_hours: Math.max(0, Math.round((nowMs - addedMs) / 3600000)),
            locality: typeof r.locality === 'string' ? r.locality : null,
            // Resident free-text is deliberately absent — see header note 3.
            ai_description: typeof ai.description === 'string' ? ai.description : null,
            has_photo: !!r.photo_path,
          });
        } catch (_) {
          // One malformed record must never wipe the whole layer.
          failed++;
        }
      }
      reports.sort((a, b) => b.date_added.localeCompare(a.date_added));
    }
  } catch (_) {
    indexOk = false;
  }

  const partial = !indexOk || failed > 0;
  const body = {
    source: 'Making Sense Bali',
    licence: 'CC BY 4.0 — attribute "Data: Making Sense Bali", linked to https://mdg-bali.github.io/makingsensebali/',
    category: 'burning',
    max_age_days: REPORT_MAX_AGE_DAYS,
    // Consumers (notably the archive worker) must be able to tell "no burning
    // reported" from "we could not read upstream" — otherwise a transient
    // failure gets published, and archived, as an authoritative empty record.
    partial,
    fetched: attempted - failed,
    attempted,
    generated_at: new Date(nowMs).toISOString(),
    reports,
  };

  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // public/_headers does NOT apply to Pages Functions responses, so the
      // site-wide hardening has to be restated here explicitly.
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': partial
        // Never cache a degraded read for the full TTL — a 60 s retry window
        // instead of publishing a possibly-empty layer for 10 minutes.
        ? 'public, s-maxage=60, max-age=30'
        : 'public, s-maxage=600, max-age=60, stale-while-revalidate=3600',
    },
  });
  // A partial result is still worth caching briefly (it bounds the fan-out
  // under repeated load) but must expire fast, hence the shorter TTL above.
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
