-- ──────────────────────────────────────────────────────────────────
-- schema-v4-station-daily-backfill.sql
-- ──────────────────────────────────────────────────────────────────
-- Purpose: roll up all existing rows in station_snapshots into
-- station_daily. The worker has been capturing 15-min snapshots since
-- Apr 2026 but the nightly aggregation step never shipped — so the
-- /history page's daily chart only ever saw the manually-seeded
-- Lumintang backfill. This one-shot fixes that for everything we
-- already have, and v4.1 of the worker will keep it current.
--
-- Safety:
--   • INSERT OR REPLACE is keyed on (station_id, date) — so re-running
--     is idempotent. The pre-existing Lumintang historical backfill
--     (2023-09-27 → 2025-08-09) is untouched because the worker hasn't
--     captured snapshots for those dates.
--   • Dates are computed in Asia/Makassar (WITA, UTC+8) to match
--     nafas_daily's convention and the site's display timezone.
--   • Stale-station guard: snapshots where the upstream `station_till`
--     timestamp is > 24h older than the fetch `ts` are EXCLUDED. This
--     prevents the AQICN Lumintang stale readings (frozen at 2025-08-09)
--     from polluting today's row with a fake 12.27 mean.
--
-- Apply:
--   wrangler d1 execute bali-air-archive --remote \
--     --file=./schema-v4-station-daily-backfill.sql
-- ──────────────────────────────────────────────────────────────────

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
WHERE pm25 IS NOT NULL
  AND (
    station_till IS NULL
    OR (ts - unixepoch(station_till)) BETWEEN -3600 AND 86400
  )
GROUP BY station_id, date;
