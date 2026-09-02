// Cloudflare Pages Function — proxies Making Sense Bali's community air-quality
// reports feed (github.io static JSON) for the map's burning-event overlay.
// Third-party feed: https://makingsense.fablabbali.com/data/
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
const MSB_BASE = 'https://makingsense.fablabbali.com/data/';
const REPORT_MAX_AGE_DAYS = 30;
const GRID_DEG = 0.0025; // ~275 m at Bali's latitude — collapses exact points
                         // to a neighbourhood cell, and usefully re-clusters
                         // repeat reports of the same site into one dot.
                         // (index.html groups by cell so they don't stack.)
// Validated BEFORE the id is used to build any upstream URL — never trust the
// index blindly, even though it is not user input.
//
// Deliberately shape-tolerant rather than pinned to one format. Upstream has
// already re-keyed once: v2 filenames were AQ_YYYYMMDD_HHMMSS_NNN, v3 (15 Aug
// 2026) switched to random aliases AQ_YYYYMMDD_xxxxxxxx because the old names
// encoded submission time to the second and identified reporters with a
// routine. A regex pinned to the old shape rejected 100% of the new index and
// silently emptied the layer. What actually matters for safety is that the id
// is alphanumeric/underscore only (so it cannot escape the URL path) and
// carries a parseable date prefix — both enforced here, without caring how the
// suffix is formed.
const ID_RE = /^AQ_\d{8}_[A-Za-z0-9_]{1,32}$/;
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

// Rows we have already archived, keyed by report id. This is the BASELINE the
// response is built from; upstream is only consulted for what is missing.
//
// Why: the feed grew from 46 profiles to 117 in two weeks, and 82 of those now
// fall inside the 30-day window. Fetching every one on a cache miss would be 83
// subrequests, over Cloudflare's 50-per-invocation limit on the Free plan, so
// MAX_FETCH capped it at 40 — which silently returned 31 of the 64 burning
// reports actually in window, and reported partial:false while doing it. The
// archive already held 61 of them, because the worker has been accumulating
// them a tick at a time. Reading D1 first turns a truncation problem into a
// completeness guarantee, and drops steady-state fan-out to the handful of ids
// we have genuinely never seen.
//
// It also means the layer survives upstream being unreachable: if the index
// fetch fails we serve what we have, flagged partial, instead of an empty map.
async function archivedInWindow(db, cutoffIso) {
  const rows = await db.prepare(`
    SELECT report_id, lat, lon, desa, kecamatan, kabupaten,
           date_added, ai_description, has_photo, location_precision
      FROM community_reports
     WHERE revoked_at IS NULL
       AND category = 'burning'
       AND date_added >= ?1
  `).bind(cutoffIso).all();
  const out = new Map();
  for (const r of (rows.results || [])) {
    if (r.lat == null || r.lon == null || !r.date_added) continue;
    out.set(r.report_id, {
      id: r.report_id,
      // Already snapped on the way in — never re-snap, and never trust a raw
      // upstream coordinate to have reached this table unsnapped.
      lat: r.lat,
      lon: r.lon,
      date_added: r.date_added,
      desa: r.desa || null,
      kecamatan: r.kecamatan || null,
      kabupaten: r.kabupaten || null,
      location_precision: r.location_precision || null,
      ai_description: r.ai_description || null,
      has_photo: !!r.has_photo,
    });
  }
  return out;
}

export async function onRequestGet({ request, env, waitUntil }) {
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
  const cutoffIso = new Date(cutoffMs).toISOString();
  let failed = 0;
  let attempted = 0;
  let indexOk = false;
  let indexProfiles = 0;
  let truncated = 0;

  // Baseline from our own archive. Never fatal: if D1 is unreachable we fall
  // through to a pure upstream read, which is the old behaviour.
  let archived = new Map();
  try {
    if (env.ARCHIVE_DB) archived = await archivedInWindow(env.ARCHIVE_DB, cutoffIso);
  } catch (_) { archived = new Map(); }

  const byId = new Map();

  try {
    const idx = await fetchJSON(MSB_BASE + 'reports/index.json');
    const profiles = Array.isArray(idx && idx.profiles) ? idx.profiles : [];
    indexOk = profiles.length > 0;
    indexProfiles = profiles.length;

    if (indexOk) {
      const padMs = 2 * 86400000;
      const cutoffYmd = new Date(cutoffMs - padMs).toISOString().slice(0, 10).replace(/-/g, '');
      const inWindow = profiles
        .map((p) => String(p).replace(/\.json$/, ''))
        .filter((id) => ID_RE.test(id) && ymdFromId(id) >= cutoffYmd);

      // The index is authoritative on what is still PUBLISHED. An archived row
      // whose id has left the index was withdrawn upstream; drop it now rather
      // than waiting for the worker's revocation sweep to catch up.
      const published = new Set(inWindow);
      for (const [id, row] of archived) {
        if (published.has(id)) byId.set(id, row);
      }

      // Fetch only what we have never seen. Newest first so that if the cap
      // ever bites it defers the OLDEST unseen reports, which the next tick
      // picks up — the shortfall is temporary rather than permanent.
      const missing = inWindow
        .filter((id) => !archived.has(id))
        .sort()
        .reverse();
      truncated = Math.max(0, missing.length - MAX_FETCH);
      const ids = missing.slice(0, MAX_FETCH);
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
          const admin = r.admin_area || {};
          // Grouping key. Upstream states admin_area is authoritative and that
          // `name`/`locality` may carry a looser colloquial area, so prefer the
          // desa and fall back only if it is absent.
          const desa = typeof admin.desa === 'string' ? admin.desa
                     : (typeof r.locality === 'string' ? r.locality : null);
          byId.set(id, {
            id,
            lat: snap(lat),
            lon: snap(lon),
            date_added: r.date_added,
            desa,
            kecamatan: typeof admin.kecamatan === 'string' ? admin.kecamatan : null,
            kabupaten: typeof admin.kabupaten === 'string' ? admin.kabupaten : null,
            // Upstream's own precision claim, passed through so the frontend can
            // refuse to imply more precision than the data has. Today every
            // report is "administrative_area"; "grid_1km" and "unavailable" are
            // documented as possible.
            location_precision: typeof r.location_precision === 'string' ? r.location_precision : null,
            // Resident free-text is deliberately absent — see header note 3.
            ai_description: typeof ai.description === 'string' ? ai.description : null,
            has_photo: !!r.photo_path,
          });
        } catch (_) {
          // One malformed record must never wipe the whole layer.
          failed++;
        }
      }
    }
  } catch (_) {
    indexOk = false;
  }

  // Upstream unreachable: serve the archive rather than an empty map. Flagged
  // partial below, so the worker will not treat it as an authoritative record.
  if (!indexOk && archived.size) {
    for (const [id, row] of archived) byId.set(id, row);
  }

  // age_days is computed here, once, for both sources — it is a function of
  // now, not a stored property, so deriving it per-source would let the two
  // paths drift.
  const reports = [...byId.values()]
    .map((r) => {
      const addedMs = Date.parse(r.date_added);
      return { ...r, age_days: Math.max(0, Math.floor((nowMs - addedMs) / 86400000)) };
    })
    .filter((r) => Number.isFinite(Date.parse(r.date_added)))
    .sort((a, b) => b.date_added.localeCompare(a.date_added));

  // `rejectedAll` is the lesson from the v3 cutover: upstream re-keyed every
  // filename, our id regex matched none of them, and the endpoint returned
  // HTTP 200 with reports:[] and partial:false — i.e. it asserted "no burning
  // anywhere in Bali" with total confidence, and the map went blank with no
  // signal anywhere. An index that lists reports but yields nothing to fetch is
  // a fault on OUR side, and must be reported as one.
  // rejectedAll only fires when the archive is ALSO empty — with a populated
  // archive, fetching nothing new is the normal steady state, not a fault.
  const rejectedAll = indexOk && indexProfiles > 0 && attempted === 0 && byId.size === 0;
  // `truncated` closes a gap this endpoint shipped with: MAX_FETCH capped the
  // fan-out, but nothing reported the cap being hit, so it returned 31 of 64
  // in-window reports with partial:false — silently incomplete, exactly the
  // failure mode `partial` exists to prevent. A deliberate cap is still a
  // shortfall and must be declared.
  const partial = !indexOk || rejectedAll || failed > 0 || truncated > 0;
  const body = {
    source: 'Making Sense Bali',
    licence: 'CC BY 4.0 — attribute "Data: Making Sense Bali", linked to https://makingsense.fablabbali.com/',
    category: 'burning',
    max_age_days: REPORT_MAX_AGE_DAYS,
    // Consumers (notably the archive worker) must be able to tell "no burning
    // reported" from "we could not read upstream" — otherwise a transient
    // failure gets published, and archived, as an authoritative empty record.
    partial,
    fetched: attempted - failed,
    attempted,
    // Reports served from our own archive without an upstream fetch. In steady
    // state this is nearly all of them.
    from_archive: archived.size,
    // In-window reports we knew about but deferred to a later tick.
    deferred: truncated,
    index_profiles: indexProfiles,
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
