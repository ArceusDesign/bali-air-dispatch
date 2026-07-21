-- ─────────────────────────────────────────────────────────────────────────────
-- v5 — US-EPA humidity correction for the Plantower-based networks
-- Applied to production 2026-07-21. Recorded here so the rewrite of live rows
-- is replayable and auditable, per the v2/v3/v4 convention.
--
-- WHY. AirGradient and PurpleAir both use Plantower PM modules, which size
-- particles optically and therefore over-read when humidity swells them with
-- water. Bali runs 45–70% RH, so the uncorrected figures we had been publishing
-- ran high — roughly a third too high at the humid end. AirGradient applies the
-- US-EPA 2021 correction to produce the `pm02Compensated` / `pm02_corrected`
-- value on its own dashboard, but exposes that field only on the device's LAN
-- API or its token-gated cloud API, never on the anonymous public feed we read.
-- The algorithm is published and we already ingest both inputs, so live.js now
-- computes it (see epaCorrectPm25) and publishes the corrected value.
--
-- WHAT IS PRESERVED. `station_snapshots.pm25_raw` holds the exact figure fed
-- into the correction, so `epaCorrectPm25(pm25_raw, humidity) === pm25` for
-- every corrected row and the whole thing is reversible. Nothing a sensor
-- actually reported is lost.
--
-- SCOPE. Only `ag-*` rows existed at the time (the AirGradient source was added
-- the day before), so this rewrote 175 rows, all of which carried humidity.
-- PurpleAir history is NOT rewritten and cannot be: `humidity` was never
-- requested from their API before this change, so pre-2026-07-21 `pa-*` rows
-- have no RH to correct with and correctly remain raw (pm25_raw IS NULL).
-- Every non-Plantower source (Nafas, AQICN, IQAir, Smart Citizen, OpenAQ,
-- Airly) is untouched and keeps pm25_raw NULL.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Columns (additive; existing rows unaffected).
ALTER TABLE station_snapshots ADD COLUMN pm25_raw REAL;

-- 2. One-time rewrite of the already-archived AirGradient rows.
--    `WHERE pm25_raw IS NULL` is the idempotency guard: once a row is corrected
--    its raw figure is non-null, so re-running this can never double-correct.
--    Bands/coefficients mirror epaCorrectPm25() in functions/api/live.js exactly
--    — verified equal across all archived rows (0 mismatches).
UPDATE station_snapshots
SET pm25_raw = pm25,
    pm25 = ROUND(MAX(0.0, CASE
      WHEN pm25 < 30  THEN 0.524*pm25 - 0.0862*humidity + 5.75
      WHEN pm25 < 50  THEN (0.786*(pm25/20.0-1.5) + 0.524*(1-(pm25/20.0-1.5)))*pm25
                           - 0.0862*humidity + 5.75
      WHEN pm25 < 210 THEN 0.786*pm25 - 0.0862*humidity + 5.75
      WHEN pm25 < 260 THEN (0.69*(pm25/50.0-4.2) + 0.786*(1-(pm25/50.0-4.2)))*pm25
                           - 0.0862*humidity*(1-(pm25/50.0-4.2))
                           + 2.966*(pm25/50.0-4.2) + 5.75*(1-(pm25/50.0-4.2))
                           + 0.000884*pm25*pm25*(pm25/50.0-4.2)
      ELSE                 2.966 + 0.69*pm25 + 0.000884*pm25*pm25 END), 1)
WHERE station_id LIKE 'ag-%'
  AND pm25 IS NOT NULL
  AND humidity IS NOT NULL
  AND pm25_raw IS NULL;

-- 3. station_daily needs no migration: the archive worker's rollupDaily
--    recomputes the trailing 3 days from station_snapshots, so the corrected
--    values propagated on the next tick (verified in production).

-- To REVERSE the correction for any row, restore the stored raw figure:
--   UPDATE station_snapshots SET pm25 = pm25_raw, pm25_raw = NULL
--   WHERE pm25_raw IS NOT NULL;
