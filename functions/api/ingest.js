// Cloudflare Pages Function — community-contributed sensor ingest.
//
// The FIRST write endpoint on this site. Every other source is pulled from a
// public network on a schedule; this one lets a resident running their own
// hardware POST readings directly. See schema-v8-contributed-sensors.sql for
// the trust posture and why readings land in the universal tables.
//
//   POST /api/ingest
//   Authorization: Bearer <token>
//   Content-Type: application/json
//   {"pm25": 12.3, "pm10": 15.0, "pm1": 9.1, "humidity": 68, "temperature": 29.1,
//    "ts": "2026-08-19T12:00:00Z"}
//
// Only `pm25` is required. `ts` defaults to now.
//
// ─── DESIGN NOTES ──────────────────────────────────────────────────────────
// • NO CORS. This is device-to-server; a browser has no business holding a
//   write token. Omitting the header is the point, not an oversight.
// • Uniform 401. A bad token, an unknown token and a deactivated sensor all
//   return the identical response, so the endpoint cannot be used to test
//   whether a token exists.
// • Tokens are compared by SHA-256 hash. The raw token is never stored, never
//   logged, and never echoed back in any response.
// • Timestamps are clamped to a narrow window around now. Without this, a
//   contributor (or anyone who obtained their token) could backfill arbitrary
//   history and rewrite the archive's past.
// • public/_headers does not apply to Functions responses, so the security
//   headers are set explicitly here.

const MAX_BODY_BYTES = 2048;

// Physical plausibility bounds. Anything outside these is a malfunction or a
// mistake, and archiving it would corrupt the record more than dropping it.
const LIMITS = {
  pm25:        [0, 2000],
  pm10:        [0, 2000],
  pm1:         [0, 2000],
  humidity:    [0, 100],
  temperature: [-20, 60],
};

const SEC_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: SEC_HEADERS });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Explicit type check BEFORE coercion. `Number(null)` and `Number('')` are both
// 0, which is finite — so a naive isFinite() check would silently turn a
// missing reading into a real 0.0 µg/m³ "clean air" record. That exact trap has
// bitten this codebase three times (agNum, scPickSensor, epaCorrectPm25); it is
// the worst direction to be wrong in, so it is guarded at every boundary.
function num(v, key) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'number' && typeof v !== 'string') return { ok: false, key };
  const n = +v;
  if (!Number.isFinite(n)) return { ok: false, key };
  const [lo, hi] = LIMITS[key];
  if (n < lo || n > hi) return { ok: false, key };
  return { ok: true, value: +n.toFixed(1) };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...SEC_HEADERS, Allow: 'POST' } });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: { ...SEC_HEADERS, Allow: 'POST' },
    });
  }
  const db = env.ARCHIVE_DB;
  if (!db) return reply(503, { error: 'unavailable' });

  // ── auth ────────────────────────────────────────────────────────────────
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/.exec(auth.trim());
  // Same response for a malformed header as for a wrong token — no oracle.
  if (!m) return reply(401, { error: 'unauthorized' });

  let sensor;
  try {
    sensor = await db.prepare(
      `SELECT station_id, name, lat, lon, sensor_type, has_rh, min_interval_s, active, last_post_ts
         FROM contrib_sensors WHERE token_sha256 = ?1`
    ).bind(await sha256Hex(m[1])).first();
  } catch (_) {
    return reply(503, { error: 'unavailable' });
  }
  if (!sensor || !sensor.active) return reply(401, { error: 'unauthorized' });

  // ── body ────────────────────────────────────────────────────────────────
  const len = +(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return reply(413, { error: 'body_too_large' });
  let raw;
  try {
    raw = await request.text();
  } catch (_) {
    return reply(400, { error: 'unreadable_body' });
  }
  // Re-check after reading: Content-Length is client-supplied and may lie or
  // be absent (chunked encoding).
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: 'body_too_large' });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return reply(400, { error: 'invalid_json' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return reply(400, { error: 'invalid_payload' });
  }

  const fields = {};
  for (const key of Object.keys(LIMITS)) {
    const r = num(payload[key], key);
    if (!r.ok) return reply(400, { error: 'invalid_field', field: key });
    fields[key] = r.value;
  }
  if (fields.pm25 === null) return reply(400, { error: 'pm25_required' });

  // ── timestamp ───────────────────────────────────────────────────────────
  const nowMs = Date.now();
  let tsMs = nowMs;
  if (payload.ts !== undefined && payload.ts !== null && payload.ts !== '') {
    tsMs = typeof payload.ts === 'number'
      ? (payload.ts < 1e11 ? payload.ts * 1000 : payload.ts)   // seconds or ms
      : Date.parse(String(payload.ts));
    if (!Number.isFinite(tsMs)) return reply(400, { error: 'invalid_ts' });
    // Narrow window only. A wider one would let anyone holding the token
    // rewrite archived history rather than just append to it.
    if (tsMs > nowMs + 5 * 60000) return reply(400, { error: 'ts_in_future' });
    if (tsMs < nowMs - 24 * 3600000) return reply(400, { error: 'ts_too_old' });
  }
  const tsSec = Math.floor(tsMs / 1000);

  // ── rate limit ──────────────────────────────────────────────────────────
  // The gate IS the write: a single conditional UPDATE that only succeeds when
  // the interval has genuinely elapsed. Two properties matter here, and the
  // obvious read-then-check version has neither.
  //
  //  1. ATOMIC. Reading last_post_ts and then checking it is a TOCTOU race:
  //     Pages Functions run concurrently across isolates and colos, D1 holds no
  //     lock between two round trips, so every concurrent request reads the
  //     same stale value and every one passes. The limiter would then bound
  //     serial posting only — precisely the behaviour an honest device already
  //     has and an abusive one does not. Here the database decides, once.
  //
  //  2. NO WRITE ON REJECTION. The previous version bumped a reject_count on
  //     every 429, which turned the limiter into a 1:1 request-to-write
  //     amplifier against a D1 instance shared with the archive workers.
  //     D1's write quota is far tighter than its read quota, so a flood would
  //     exhaust writes and stop snapshotUniversal() committing — silent,
  //     permanent gaps in the curated record, which is the one thing this
  //     project treats as absolute. A rejected request now costs one indexed
  //     UPDATE that changes nothing, and never grows the table.
  const minGap = Math.max(10, +sensor.min_interval_s || 60);
  const nowSec = Math.floor(nowMs / 1000);
  let claim;
  try {
    claim = await db.prepare(`
      UPDATE contrib_sensors
         SET last_post_ts = ?2, post_count = post_count + 1
       WHERE station_id = ?1
         AND active = 1
         AND (last_post_ts IS NULL OR ?2 - last_post_ts >= ?3)
    `).bind(sensor.station_id, nowSec, minGap).run();
  } catch (_) {
    return reply(503, { error: 'unavailable' });
  }
  if (!claim || !claim.meta || claim.meta.changes === 0) {
    return new Response(JSON.stringify({ error: 'too_many_requests', min_interval_s: minGap }), {
      status: 429, headers: { ...SEC_HEADERS, 'Retry-After': String(minGap) },
    });
  }

  // ── store ───────────────────────────────────────────────────────────────
  // Humidity is recorded but NOT used to correct pm25 unless a co-located RH
  // sensor is confirmed (has_rh). The US-EPA correction is only meaningful when
  // the humidity was measured in the same air as the particles; borrowing it
  // from elsewhere yields a confidently wrong number. Until then we publish the
  // raw value and say so — pm25_raw stays NULL, which is what every downstream
  // consumer already reads as "uncorrected".
  const publishPm25 = fields.pm25;
  let batchRes;
  try {
    batchRes = await db.batch([
      db.prepare(`
        INSERT INTO stations (station_id, source, name, lat, lon, type, first_seen, last_seen)
        VALUES (?1, 'Community', ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(station_id) DO UPDATE SET
          name = excluded.name, lat = excluded.lat, lon = excluded.lon,
          type = excluded.type, last_seen = excluded.last_seen
      `).bind(sensor.station_id, sensor.name, sensor.lat, sensor.lon,
              sensor.sensor_type || 'Community sensor', tsSec),
      db.prepare(`
        INSERT OR IGNORE INTO station_snapshots
          (station_id, ts, pm25, pm10, pm1, aqi, temperature, humidity, station_till, pm25_raw)
        VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL)
      `).bind(sensor.station_id, tsSec, publishPm25, fields.pm10, fields.pm1,
              fields.temperature, fields.humidity, new Date(tsMs).toISOString()),
      // last_post_ts / post_count were already advanced by the atomic claim
      // above — that UPDATE is the rate-limit decision, not bookkeeping.
    ]);
  } catch (_) {
    return reply(503, { error: 'store_failed' });
  }

  // INSERT OR IGNORE silently no-ops when (station_id, ts) already exists —
  // that is what protects the archive from being overwritten, and it must stay.
  // But reporting "ok" for a write that was discarded would be a lie: a
  // contributor posting on a fixed cadence can collide on the same second and
  // would never learn their readings were being dropped. Report what actually
  // happened. Still 2xx, because a duplicate is a successful no-op for an
  // idempotent retry, not a client error.
  const stored = !!(batchRes && batchRes[1] && batchRes[1].meta && batchRes[1].meta.changes > 0);
  return reply(202, {
    ok: true,
    stored,
    ...(stored ? {} : { reason: 'duplicate_timestamp' }),
    station_id: sensor.station_id,
    stored_ts: new Date(tsSec * 1000).toISOString(),
    pm25: publishPm25,
    corrected: false,
    min_interval_s: minGap,
  });
}
