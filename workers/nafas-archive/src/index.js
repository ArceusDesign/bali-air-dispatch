// Cloudflare Worker — scheduled archive of Nafas Bali sensor data into D1.
//
// Runs on cron (every 15 min by default; see wrangler.toml [triggers]).
// Also exposes a /run endpoint for manual triggering (secret-gated).
//
// Data flow per tick:
//   1. GET https://outdoor.nafas.co.id/api/v1/location/all
//   2. Filter by Bali bbox → list of station UUIDs
//   3. Upsert into nafas_stations (catalog)
//   4. For each station, GET /api/v1/location/detail/{uuid} (parallel)
//   5. INSERT into nafas_snapshots (append-only, idempotent via PK)
//      UPSERT nafas_hourly from detail.measurement.hourly[]
//      UPSERT nafas_daily  from detail.measurement.daily[]
//   6. Append one row to archive_runs
//
// Idempotent by design: re-running the same tick is a no-op (all writes keyed).

const NAFAS_ALL    = 'https://outdoor.nafas.co.id/api/v1/location/all';
const NAFAS_DETAIL = (uuid) => `https://outdoor.nafas.co.id/api/v1/location/detail/${uuid}`;

// Bali bounding box — identical filter to functions/api/live.js
const BALI = { latMin: -9.2, latMax: -8.0, lonMin: 114.4, lonMax: 115.8 };

const HTTP = { 'Accept': 'application/json' };

function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}
function toIntOrNull(v) {
  const n = toNumberOrNull(v);
  return n == null ? null : Math.round(n);
}
function dateOnly(isoLike) {
  // Nafas daily rows use "from": "2026-04-01 00:00:00" style (Asia/Makassar).
  // We want YYYY-MM-DD.
  if (!isoLike) return null;
  const m = String(isoLike).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Parse an upstream `station_till` to unix-ms, WITA-aware (mirrors
// functions/api/live.js parseLastSeenMs): a timestamp with no zone is Nafas's
// "YYYY-MM-DD HH:MM:SS" in Asia/Makassar (UTC+8), so we append +08:00.
function parseTillMs(s) {
  if (!s) return null;
  let t = String(s).trim();
  if (t.includes(' ') && !t.includes('T')) t = t.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(t)) t = t + '+08:00';
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}
// Stop archiving a sensor's snapshots once its reading has been frozen/stale for
// longer than this. A short outage (≤ 48 h) still records, so the series stays
// continuous if the sensor recovers; a sensor stuck for days/months (e.g. a
// frozen AQICN echo) stops painting a fake flat line on the chart and stops
// inflating the "hours above WHO" counts. The catalog row is still upserted so
// the station stays listed (it just gathers no new data points).
const STALE_RECORD_MS = 48 * 60 * 60 * 1000;

async function fetchBaliStations() {
  const r = await fetch(NAFAS_ALL, { headers: HTTP });
  if (!r.ok) throw new Error(`Nafas /all HTTP ${r.status}`);
  const data = await r.json();
  if (!data?.success || !Array.isArray(data.body)) throw new Error('Nafas /all: unexpected shape');
  return data.body.filter(loc => {
    const lat = +loc.latitude, lon = +loc.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (loc.visible === false) return false;
    return lat >= BALI.latMin && lat <= BALI.latMax &&
           lon >= BALI.lonMin && lon <= BALI.lonMax;
  });
}

async function fetchDetail(uuid) {
  const r = await fetch(NAFAS_DETAIL(uuid), { headers: HTTP });
  if (!r.ok) return null;
  const data = await r.json();
  return data?.body || null;
}

async function upsertStation(db, loc, nowSec) {
  await db.prepare(`
    INSERT INTO nafas_stations (uuid, name, lat, lon, sponsor, vendor, first_seen, last_seen)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(uuid) DO UPDATE SET
      name = excluded.name,
      lat  = excluded.lat,
      lon  = excluded.lon,
      sponsor = excluded.sponsor,
      vendor  = excluded.vendor,
      last_seen = excluded.last_seen
  `).bind(
    loc.uuid,
    loc.name || `Nafas ${String(loc.uuid).slice(0,8)}`,
    +loc.latitude, +loc.longitude,
    loc.sponsor?.name || null,
    loc.vendor || null,
    nowSec
  ).run();
}

async function insertSnapshot(db, uuid, nowSec, detail) {
  // INSERT OR IGNORE — dedupe by (uuid, ts)
  await db.prepare(`
    INSERT OR IGNORE INTO nafas_snapshots
      (uuid, ts, station_till, pm25, pm10, pm1, aqi, temperature, humidity, pressure)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).bind(
    uuid, nowSec,
    detail.till || null,
    toNumberOrNull(detail.pm25),
    toNumberOrNull(detail.pm10),
    toNumberOrNull(detail.pm1),
    toIntOrNull(detail.aqi),
    toNumberOrNull(detail.temperature),
    toNumberOrNull(detail.humidity),
    toNumberOrNull(detail.pressure)
  ).run();
}

function buildHourlyStmt(db) {
  return db.prepare(`
    INSERT INTO nafas_hourly
      (uuid, hour_start, pm25, pm10, pm1, aqi, temperature, humidity, pressure)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(uuid, hour_start) DO UPDATE SET
      pm25 = excluded.pm25, pm10 = excluded.pm10, pm1 = excluded.pm1,
      aqi = excluded.aqi, temperature = excluded.temperature,
      humidity = excluded.humidity, pressure = excluded.pressure
  `);
}
function buildDailyStmt(db) {
  return db.prepare(`
    INSERT INTO nafas_daily
      (uuid, date, pm25, pm10, pm1, aqi, temperature, humidity, pressure)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(uuid, date) DO UPDATE SET
      pm25 = excluded.pm25, pm10 = excluded.pm10, pm1 = excluded.pm1,
      aqi = excluded.aqi, temperature = excluded.temperature,
      humidity = excluded.humidity, pressure = excluded.pressure
  `);
}

// ── Universal snapshot helpers (Edition III) ───────────────────────────
// Snapshot every station from /api/live into the universal tables, in
// addition to the Nafas-specific deep dive (hourly/daily aggregates).
async function fetchUnifiedLive(originBase) {
  // CF-to-CF fetch — calls our own /api/live aggregator from the worker.
  // originBase is set via env.LIVE_ORIGIN (defaults to baliair.pages.dev).
  //
  // CRITICAL: pass ?fresh=1 to BYPASS the D1 fast-path. Without this we
  // create a circular dependency — /api/live reads its most-recent snapshot
  // from D1, the worker writes that snapshot's stale values back into D1,
  // and live readings freeze. ?fresh=1 forces /api/live to call upstream
  // sources directly. Also disable the fetch's cf cache for the same reason.
  // The per-tick cache-buster is load-bearing, not belt-and-braces. /api/live
  // responds with `s-maxage=900, stale-while-revalidate=86400`, so the edge can
  // keep handing this worker a STALE copy for up to 24 h while it revalidates in
  // the background — `cf.cacheTtl: 0` does not prevent that. Observed 2026-07-20:
  // a newly-added source was serving on the origin for 20+ minutes while the
  // worker kept archiving a pre-deploy payload that omitted it. Archiving a
  // cached aggregate would also silently freeze readings, which is exactly the
  // failure ?fresh=1 exists to prevent. A unique query key forces a real miss.
  //
  // RETRIED, because a failure here is not an error page — it is a permanently
  // missing archive tick. The aggregator runs 7 upstream networks in one
  // invocation and has measurably brushed Cloudflare's CPU ceiling (4
  // "Exceeded CPU Time Limits" in 24h; a 60-minute hole in the record traced
  // to exactly that). Those failures are transient by nature — the next
  // invocation gets a fresh CPU budget — so a single attempt turned a blip
  // into data loss we cannot recover. Cron has minutes of wall time available
  // and this only re-runs on failure, so the cost of retrying is nil next to
  // the cost of a gap. Each attempt takes a fresh _cb so nothing can be served
  // from cache, for the same reason the buster exists at all.
  const base = (originBase || 'https://baliair.pages.dev').replace(/\/$/,'');
  const ATTEMPTS = 3;
  let data = null, lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await fetch(base + '/api/live?fresh=1&_cb=' + Date.now() + '-' + attempt, {
        headers: { Accept:'application/json' },
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      if (!r.ok) throw new Error('live HTTP ' + r.status);
      data = await r.json();
      if (attempt > 1) console.log('archive: /api/live succeeded on attempt', attempt);
      break;
    } catch (err) {
      lastErr = err;
      console.error('archive: /api/live attempt', attempt, 'failed:', err && err.message);
      if (attempt < ATTEMPTS) await new Promise(res => setTimeout(res, 3000 * attempt));
    }
  }
  if (!data) throw lastErr || new Error('live fetch failed');
  // SAFEGUARD #1: belt-and-braces check — if the response somehow returns
  // the fast-path payload despite ?fresh=1, throw rather than write a loop
  // back to D1. Better to skip a tick than freeze the archive.
  if (data && data.fast_path === true) {
    throw new Error('Worker received fast_path=true response (loop guard tripped)');
  }
  return data;
}

// SAFEGUARD #2 — stale-loop detector. v2: previous version compared pm25
// values which produced too many false positives (Airly/IQAir/AQICN report
// hourly so 3 of every 4 fifteen-minute snapshots will legitimately have
// the same pm25 — that's a plateau, not a freeze).
//
// Real loop signature: the upstream `station_till` timestamp is identical
// across MANY consecutive runs. During the Apr-27→May-2 freeze, every
// snapshot had till="2026-04-26..." regardless of when we wrote it.
//
// Detection: compute the most-common station_till across the just-written
// snapshots, and count how many distinct station_till values exist. If the
// run wrote >= 10 snapshots but only 1-2 distinct till values appeared,
// upstream isn't refreshing — likely a loop.
async function detectStaleLoop(db, currentTs) {
  try {
    const r = await db.prepare(`
      SELECT COUNT(*) AS total,
             COUNT(DISTINCT station_till) AS distinct_tills
      FROM station_snapshots
      WHERE ts = ?1 AND station_till IS NOT NULL
    `).bind(currentTs).first();
    return r;  // {total, distinct_tills}
  } catch (_) { return null; }
}

async function snapshotUniversal(db, live, nowSec) {
  if (!live?.stations?.length) return { stationsSeen:0, snapshots:0 };
  const stmtStation = db.prepare(`
    INSERT INTO stations (station_id, source, name, lat, lon, type, first_seen, last_seen)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(station_id) DO UPDATE SET
      source = excluded.source,
      name   = excluded.name,
      lat    = excluded.lat,
      lon    = excluded.lon,
      type   = excluded.type,
      last_seen = excluded.last_seen
  `);
  // pm25 is the value we PUBLISH; pm25_raw preserves the uncorrected sensor
  // figure for the Plantower-based networks (AirGradient, PurpleAir) whose
  // readings we humidity-correct in live.js. Storing both keeps the correction
  // auditable and reversible — nothing the sensor actually reported is lost.
  const stmtSnap = db.prepare(`
    INSERT OR IGNORE INTO station_snapshots
      (station_id, ts, pm25, pm10, pm1, aqi, temperature, humidity, station_till, pm25_raw)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `);

  const stationBatch = [];
  const snapBatch = [];
  for (const s of live.stations) {
    if (!s?.id || !Number.isFinite(+s.lat) || !Number.isFinite(+s.lon)) continue;
    // Skip scraped IQAir stations (iqs-*): the iqair-scrape worker already keeps
    // their full hourly/daily/monthly history in the iq_scrape_* tables.
    // Re-snapshotting them here duplicates them into stations/station_snapshots,
    // which /api/live + /history would otherwise have to filter out as stale
    // duplicate pins. Skipping at the source keeps those tables clean.
    if (String(s.id).startsWith('iqs-')) continue;
    // Skip community-contributed sensors (cs-*): /api/ingest writes their rows
    // directly, with the CONTRIBUTOR's timestamp. Re-snapshotting them from
    // /api/live would append a second row per tick stamped with OUR poll time,
    // inflating the archive and — worse — freezing the last pushed value into a
    // fresh-looking row every 15 minutes if the device goes offline.
    if (String(s.id).startsWith('cs-')) continue;
    // Skip OFFLINE tombstone pins (off:true — Smart Citizen retention): they
    // carry no current reading (pm25 null, lastSeen = last archived day).
    // Without this, a freshly-dead unit would get null-pm25 snapshots for the
    // first 48 h until the frozen-sensor guard below kicks in. Skip the
    // catalog upsert too — it would overwrite last_seen with the tombstone's
    // resurfacing time rather than real data time.
    if (s.off) continue;
    stationBatch.push(stmtStation.bind(
      s.id, s.source || 'Unknown', s.name || s.id,
      +s.lat, +s.lon, s.type || null, nowSec
    ));
    // Frozen-sensor guard: if the upstream reading time (station_till) is more
    // than 48 h behind now, the sensor is stuck echoing a stale value — record
    // the catalog row but NOT a snapshot, so we don't archive the frozen echo.
    const tillMs = parseTillMs(s.lastSeen);
    if (tillMs != null && (nowSec * 1000 - tillMs) > STALE_RECORD_MS) continue;
    snapBatch.push(stmtSnap.bind(
      s.id, nowSec,
      toNumberOrNull(s.pm25), toNumberOrNull(s.pm10), toNumberOrNull(s.pm1),
      toIntOrNull(s.aqi),
      toNumberOrNull(s.temperature), toNumberOrNull(s.humidity),
      s.lastSeen || null,
      toNumberOrNull(s.pm25_raw)
    ));
  }
  if (stationBatch.length) await db.batch(stationBatch);
  if (snapBatch.length)    await db.batch(snapBatch);
  // stationsSeen excludes off:true tombstones — they're skipped above and
  // would otherwise drift the archive_runs stations_seen ops metric.
  return { stationsSeen: live.stations.filter(s => !(s && s.off)).length, snapshots: snapBatch.length };
}

// Roll up the last 3 days of station_snapshots into station_daily.
// Re-runs every tick are safe (INSERT OR REPLACE keyed on (station_id,date)),
// and 3-day window keeps today/yesterday accurate as late snapshots arrive
// and snapshots cross midnight WITA. Dates are computed in Asia/Makassar
// (UTC+8) to match nafas_daily and the site's display timezone.
//
// Stale-station guard: snapshots where the upstream `station_till` is more
// than 24h older than fetch `ts` (or >1h in the future) are EXCLUDED. This
// keeps frozen-upstream sensors (e.g. AQICN Lumintang's 2025-08-09 readings)
// from polluting today's row with fake means.
async function rollupDaily(db, nowSec) {
  const cutoffSec = nowSec - 3 * 86400;
  try {
    const r = await db.prepare(`
      INSERT OR REPLACE INTO station_daily
        (station_id, date, pm25_mean, pm25_min, pm25_max, aqi_max, sample_n)
      SELECT
        station_id,
        strftime('%Y-%m-%d', datetime(ts, 'unixepoch', '+8 hours')) AS date,
        ROUND(AVG(pm25), 2) AS pm25_mean,
        ROUND(MIN(pm25), 2) AS pm25_min,
        ROUND(MAX(pm25), 2) AS pm25_max,
        MAX(aqi)            AS aqi_max,
        COUNT(*)            AS sample_n
      FROM station_snapshots
      WHERE ts >= ?1
        AND pm25 IS NOT NULL
        AND (
          station_till IS NULL
          OR (ts - unixepoch(station_till)) BETWEEN -3600 AND 86400
        )
      GROUP BY station_id, date
    `).bind(cutoffSec).run();
    return r?.meta?.changes ?? 0;
  } catch (e) {
    console.warn('rollupDaily failed: ' + (e.message || String(e)));
    return 0;
  }
}

// ── Community burning reports (Making Sense Bali) ──────────────────────────
// Archives the same reports the map shows, because the upstream feed is a
// rolling publication, not an archive: it has no historical endpoint and
// removes reports when a resident revokes consent. See
// schema-v6-community-reports.sql for the full rationale.
//
// Reads OUR OWN /api/reports rather than upstream directly, deliberately: that
// endpoint already applies the burning filter, the test/junk content heuristic
// and — critically — the ~275 m coordinate snapping. Duplicating those rules
// here would let them drift, and a drift in the snapping rule specifically
// would mean archiving building-level coordinates we have committed never to
// store. One implementation, one place. (No cache-buster needed: unlike
// /api/live there is no D1 round-trip to loop through, so a ≤10 min cached
// copy is harmless at a 15 min cadence.)
//
// Liveness is judged against the upstream index, NOT against /api/reports:
// /api/reports only returns the last 30 days, so a still-published older
// report is absent from it and would otherwise be mistaken for a revocation.
const MSB_INDEX = 'https://mdg-bali.github.io/makingsensebali/data/reports/index.json';
const REPORTS_TIMEOUT_MS = 10000;

async function reportsArchive(db, originBase, nowSec) {
  const out = { upserts: 0, revoked: 0, note: null };

  // 1 — content to archive (already filtered + snapped by our own endpoint).
  // Timeouts throughout: this pass runs AHEAD of the IQAir watchdog, so a hung
  // third-party connection must never stall the rest of the tick.
  const url = (originBase || 'https://baliair.pages.dev').replace(/\/$/, '') + '/api/reports';
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REPORTS_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('reports HTTP ' + r.status);
  const payload = await r.json();
  const reports = Array.isArray(payload && payload.reports) ? payload.reports : [];

  if (reports.length) {
    const stmt = db.prepare(`
      INSERT INTO community_reports
        (report_id, category, lat, lon, locality, date_added,
         description, ai_description, has_photo, first_seen, last_seen, revoked_at,
         desa, kecamatan, kabupaten, location_precision)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?9, NULL, ?10, ?11, ?12, ?13)
      ON CONFLICT(report_id) DO UPDATE SET
        lat                = excluded.lat,
        lon                = excluded.lon,
        locality           = excluded.locality,
        ai_description     = excluded.ai_description,
        has_photo          = excluded.has_photo,
        last_seen          = excluded.last_seen,
        desa               = excluded.desa,
        kecamatan          = excluded.kecamatan,
        kabupaten          = excluded.kabupaten,
        location_precision = excluded.location_precision,
        -- Seen again ⇒ published again. Clears a previous revocation.
        revoked_at         = NULL
    `);
    // `description` is bound to NULL, never written: /api/reports deliberately
    // does not return the resident's free text (it carries street names, named
    // businesses and self-identifying phrasing — see that file's header), and
    // we do not collect what we have decided not to publish. The column is kept
    // so the schema stays additive and the choice stays reversible.
    const batch = [];
    for (const rep of reports) {
      if (!rep || !rep.id || rep.lat == null || rep.lon == null || !rep.date_added) continue;
      batch.push(stmt.bind(
        rep.id, 'burning', rep.lat, rep.lon, rep.desa || null, rep.date_added,
        rep.ai_description || null,
        rep.has_photo ? 1 : 0, nowSec,
        rep.desa || null, rep.kecamatan || null, rep.kabupaten || null,
        rep.location_precision || null
      ));
    }
    if (batch.length) {
      await db.batch(batch);
      out.upserts = batch.length;
    }
  }

  // 2 — revocation sweep, diffed in JS so there is no unbounded IN(...) clause
  // and no write at all on the overwhelmingly common no-change tick.
  const ir = await fetch(MSB_INDEX, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REPORTS_TIMEOUT_MS),
  });
  if (!ir.ok) { out.note = 'index_fetch_failed_skipped_sweep'; return out; }
  const idx = await ir.json();
  const profiles = Array.isArray(idx && idx.profiles) ? idx.profiles : [];
  // GUARD: an empty/garbled index must never be read as "everything was
  // revoked" — that would erase every description we hold in one tick.
  if (!profiles.length) { out.note = 'index_empty_skipped_sweep'; return out; }
  const published = new Set(profiles.map((p) => String(p).replace(/\.json$/, '')));

  const held = await db.prepare(
    `SELECT report_id FROM community_reports WHERE revoked_at IS NULL`
  ).all();
  // Legacy-format ids are excluded from the sweep entirely. Upstream re-keyed
  // every filename on 15 Aug 2026 (v3): the pre-v3 ids we archived can never
  // appear in the index again, so they would read as 12 simultaneous consent
  // withdrawals forever — permanently tripping the mass-revocation guard (which
  // is exactly what it did, correctly, every tick from the cutover onward) and,
  // once enough new reports diluted the ratio, eventually NULLing their text for
  // a reason that never happened. "Upstream changed its id scheme" is not
  // "a resident withdrew consent", and only the latter may erase words.
  const CURRENT_ID_RE = /^AQ_\d{8}_[A-Za-z0-9]{6,32}$/;
  const isLegacy = (id) => /^AQ_\d{8}_\d{6}_\d{3}$/.test(id) || !CURRENT_ID_RE.test(id);
  const heldIds = (held.results || []).map((x) => x.report_id).filter((id) => !isLegacy(id));
  const gone = heldIds.filter((id) => !published.has(id));
  if (!gone.length) return out;

  // GUARD: a partial upstream index (truncated deploy, CDN hiccup) would look
  // like a mass revocation. Real consent withdrawals are one-offs; anything
  // resembling a bulk disappearance is far more likely to be an upstream fault,
  // so log it and wait for the next tick rather than destroying text.
  //
  // The bound is max(2, 25% of held) and applies at EVERY size. An earlier
  // version gated this on `heldIds.length >= 10`, which ratchets itself off:
  // repeated bad ticks shrink the live set each time, and once it falls under
  // 10 the guard goes inert and the next bad tick erases everything. Scaling
  // the allowance instead means a genuine bulk withdrawal still completes, just
  // spread over several 15-minute ticks — which costs nothing, because the
  // alternative is unrecoverable: revocation NULLs text, and a report older
  // than 30 days never reappears in /api/reports to be restored.
  const allowed = Math.max(2, Math.floor(heldIds.length * 0.25));
  if (gone.length > allowed) {
    out.note = `mass_revocation_suspected_skipped (${gone.length} gone > ${allowed} allowed of ${heldIds.length} held)`;
    return out;
  }

  const rstmt = db.prepare(`
    UPDATE community_reports
       SET revoked_at = ?1, description = NULL, ai_description = NULL
     WHERE report_id = ?2 AND revoked_at IS NULL
  `);
  await db.batch(gone.map((id) => rstmt.bind(nowSec, id)));
  out.revoked = gone.length;
  // Count only — report ids are written into archive_runs.error, which is
  // outside the consent machinery and never cleaned up. The count is what an
  // operator needs; the ids are recoverable from the table itself.
  out.note = `revoked ${gone.length}`;
  return out;
}

async function archiveOnce(env) {
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  const db = env.ARCHIVE_DB;
  if (!db) throw new Error('ARCHIVE_DB binding missing');

  let stationsSeen = 0, snapshots = 0, hourly = 0, daily = 0;
  let universalStations = 0, universalSnaps = 0, universalDailyRows = 0;
  let ok = 1, errMsg = null;
  let watchdogNote = null;

  // ── Universal pass: snapshot every station from /api/live ────────────
  let universalWarning = null;
  try {
    const live = await fetchUnifiedLive(env.LIVE_ORIGIN);
    const u = await snapshotUniversal(db, live, nowSec);
    universalStations = u.stationsSeen;
    universalSnaps = u.snapshots;
    // Roll up the last 3 days of universal snapshots into station_daily,
    // so the /history page can chart non-Nafas stations. Idempotent.
    universalDailyRows = await rollupDaily(db, nowSec);
    // SAFEGUARD #2 — loop detection (till-distinctness based).
    const loopCheck = await detectStaleLoop(db, nowSec);
    if (loopCheck && loopCheck.total >= 10 && loopCheck.distinct_tills <= 2) {
      universalWarning = `loop_suspect: ${loopCheck.total} stations share only ${loopCheck.distinct_tills} distinct station_till value(s) — upstream may be frozen`;
      console.warn(universalWarning);
    }
  } catch (e) {
    // Non-fatal — Nafas-specific path below still runs. Record the failure.
    universalWarning = 'universal_fetch_failed: ' + (e.message || String(e));
    console.warn(universalWarning);
  }

  try {
    const stations = await fetchBaliStations();
    stationsSeen = stations.length;

    // Parallel fetch details
    const detailed = await Promise.all(stations.map(async (loc) => ({
      loc, detail: await fetchDetail(loc.uuid),
    })));

    const hourlyStmt = buildHourlyStmt(db);
    const dailyStmt  = buildDailyStmt(db);

    for (const { loc, detail } of detailed) {
      await upsertStation(db, loc, nowSec);
      if (!detail) continue;

      await insertSnapshot(db, loc.uuid, nowSec, detail);
      snapshots++;

      // Hourly — detail.measurement.hourly[] = 24 entries
      const hourlyRows = detail?.measurement?.hourly || [];
      const hourlyBatch = [];
      for (const h of hourlyRows) {
        if (!h?.from) continue;
        hourlyBatch.push(hourlyStmt.bind(
          loc.uuid, h.from,
          toNumberOrNull(h.pm25), toNumberOrNull(h.pm10), toNumberOrNull(h.pm1),
          toIntOrNull(h.aqi),
          toNumberOrNull(h.temperature), toNumberOrNull(h.humidity), toNumberOrNull(h.pressure)
        ));
      }
      if (hourlyBatch.length) {
        await db.batch(hourlyBatch);
        hourly += hourlyBatch.length;
      }

      // Daily — detail.measurement.daily[] = ~30 entries
      const dailyRows = detail?.measurement?.daily || [];
      const dailyBatch = [];
      for (const dRow of dailyRows) {
        const date = dateOnly(dRow.from || dRow.date);
        if (!date) continue;
        dailyBatch.push(dailyStmt.bind(
          loc.uuid, date,
          toNumberOrNull(dRow.pm25), toNumberOrNull(dRow.pm10), toNumberOrNull(dRow.pm1),
          toIntOrNull(dRow.aqi),
          toNumberOrNull(dRow.temperature), toNumberOrNull(dRow.humidity), toNumberOrNull(dRow.pressure)
        ));
      }
      if (dailyBatch.length) {
        await db.batch(dailyBatch);
        daily += dailyBatch.length;
      }
    }
  } catch (e) {
    ok = 0;
    errMsg = e.message || String(e);
  }

  // ── Community reports archive ─────────────────────────────────────────
  // Placed AFTER the sensor passes (they are the priority) but BEFORE the
  // watchdog, which can block for tens of seconds when it fires. This pass is
  // two small fetches and usually zero writes, and the data is irreplaceable
  // (upstream deletes on consent withdrawal and keeps no history), so it
  // should not sit behind the slowest thing in the tick. Fully isolated:
  // any failure here is recorded and never touches the sensor archive.
  let reportsNote = null;
  try {
    const rep = await reportsArchive(db, env.LIVE_ORIGIN, nowSec);
    reportsNote = `reports: ${rep.upserts} upserted, ${rep.revoked} revoked`
                + (rep.note ? ` (${rep.note})` : '');
  } catch (e) {
    reportsNote = 'reports_archive_failed: ' + (e.message || String(e));
    console.warn(reportsNote);
  }

  // ── IQAir-scrape watchdog ─────────────────────────────────────────────
  // The iqair-scrape worker's SCHEDULED invocations get killed platform-side
  // ("Exceeded CPU Limit" before writing anything) while its HTTP/binding
  // invocations run fine. This worker's cron is demonstrably reliable, so it
  // doubles as the scheduler-of-last-resort: if the STALEST active IQAir station
  // hasn't been scraped in > 70 min (a healthy cron keeps every station ≤ ~60
  // min; /api/live's FRESH_MS is 2.5 h, so 70–85 min keeps stations "live"),
  // trigger one rotation group on the iqair-scrape worker.
  //
  // ORDER: this runs LAST, AFTER the universal + Nafas archival passes above, so
  // a firing watchdog can never delay or eat the wall-clock budget of the
  // critical data writes. With the binding the call actually reaches the worker
  // and `await` now blocks for as long as that scrape takes (tens of seconds) —
  // which is exactly why it must come after archival, not before it.
  //
  // INVOCATION: via the IQAIR_SCRAPE service binding, NOT a workers.dev fetch.
  // The previous version called fetch('https://iqair-scrape.<sub>.workers.dev/
  // watchdog'), which silently returned HTTP 404 from inside a Worker — a same-
  // account Worker→Worker subrequest over the public hostname is intercepted by
  // the edge and never reaches the target. That broke the safety net: on 2026-
  // 06-14 the cron died ~01:22 UTC and this watchdog fired every 15 min for ~9h,
  // each time getting 404, so nothing recovered. The service binding routes
  // directly through the runtime (reliable, no DNS/edge, stays inside CF's
  // network). The /watchdog route stays secret-gated as defense-in-depth.
  // Healthy periods: never fires, zero extra Firecrawl spend.
  try {
    if (env.IQAIR_SCRAPE) {
      const st = await db.prepare(
        `SELECT MIN(last_scrape_ts) AS stalest FROM iq_scrape_stations WHERE active = 1`
      ).first();
      const ageMin = st && st.stalest ? (nowSec - st.stalest) / 60 : null;
      if (ageMin != null && ageMin > 70) {
        const r = await env.IQAIR_SCRAPE.fetch('https://iqair-scrape.internal/watchdog', {
          method: 'POST',
          headers: { 'X-Watchdog-Key': env.IQAIR_WATCHDOG_KEY || '' },
        });
        watchdogNote = `iqair_watchdog_fired (stalest ${Math.round(ageMin)}m, HTTP ${r.status})`;
        console.warn(watchdogNote);
      }
    }
  } catch (e) {
    watchdogNote = 'iqair_watchdog_error: ' + (e.message || String(e));
  }

  const duration = Date.now() - t0;
  try {
    // archive_runs schema only knows about Nafas counters; encode universal
    // counts into the higher columns via simple addition for visibility.
    // Combine errors: Nafas-specific failure + universal-pass warning.
    const combinedErr = [errMsg, universalWarning, reportsNote, watchdogNote].filter(Boolean).join(' | ') || null;
    await db.prepare(`
      INSERT OR REPLACE INTO archive_runs
        (ts, stations_seen, snapshots_written, hourly_upserts, daily_upserts, duration_ms, ok, error)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(
      nowSec,
      stationsSeen + universalStations,
      snapshots + universalSnaps,
      hourly,
      // daily = Nafas-specific upserts + universal-rollup rows touched this tick
      daily + universalDailyRows,
      duration, ok, combinedErr
    ).run();
  } catch (_) { /* never fail on log write */ }

  return {
    ok: !!ok, ts: nowSec,
    nafasStations: stationsSeen, nafasSnapshots: snapshots,
    universalStations, universalSnapshots: universalSnaps,
    universalDailyRows,
    hourly, daily, duration, error: errMsg,
    reports: reportsNote
  };
}

export default {
  // Scheduled cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(archiveOnce(env));
  },

  // Manual trigger — hit /run with X-Secret header matching env.CRON_SECRET
  // Useful for: first-run backfill, post-deploy sanity check, debugging.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const secret = request.headers.get('X-Secret') || url.searchParams.get('k');
      if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const result = await archiveOnce(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  },
};
