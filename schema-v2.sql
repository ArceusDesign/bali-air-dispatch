-- D1 schema additions for Edition III — universal historical archive.
-- Apply AFTER the original schema.sql (which holds nafas_*).
-- Idempotent with IF NOT EXISTS — safe to re-run.
--   wrangler d1 execute bali-air-archive --remote --file=./schema-v2.sql

-- ── Universal station catalog ──────────────────────────────────────
-- Keyed by /api/live's station id (e.g. 'pa-36601', 'aq--519205',
-- 'iq-Ubud', 'airly-100705', 'nafas-{uuid}'). Sits beside
-- nafas_stations; both can co-exist.
CREATE TABLE IF NOT EXISTS stations (
  station_id  TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  type        TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

-- ── Universal snapshot log ─────────────────────────────────────────
-- Append-only, idempotent via PRIMARY KEY (station_id, ts).
-- Every 15 min the archive worker writes one row per station.
CREATE TABLE IF NOT EXISTS station_snapshots (
  station_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,   -- unix sec UTC at fetch time
  pm25         REAL,               -- the value we PUBLISH (see pm25_raw)
  pm10         REAL,
  pm1          REAL,
  aqi          INTEGER,
  temperature  REAL,
  humidity     REAL,
  station_till TEXT,               -- upstream "till"/"lastSeen" if available
  -- Uncorrected sensor figure, for the Plantower-based networks (AirGradient,
  -- PurpleAir) whose readings live.js humidity-corrects via the published US-EPA
  -- formula before publishing them as pm25. NULL for every other source, and for
  -- PurpleAir rows predating 2026-07-21 (humidity wasn't requested from their API
  -- until then, so that history can't be retroactively corrected). Keeping the
  -- raw figure makes the correction auditable and reversible — nothing the sensor
  -- actually reported is lost. Added 2026-07-21 via:
  --   ALTER TABLE station_snapshots ADD COLUMN pm25_raw REAL;
  pm25_raw     REAL,
  PRIMARY KEY (station_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_ssnap_id_ts ON station_snapshots (station_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ssnap_ts    ON station_snapshots (ts DESC);

-- ── Universal daily aggregates ─────────────────────────────────────
-- Computed nightly from station_snapshots. ALSO used to backfill
-- embedded historical data (offline OpenAQ sensors, Kerobokan).
CREATE TABLE IF NOT EXISTS station_daily (
  station_id  TEXT NOT NULL,
  date        TEXT NOT NULL,        -- YYYY-MM-DD (Asia/Makassar / WITA)
  pm25_mean   REAL,
  pm25_min    REAL,
  pm25_max    REAL,
  pm25_p95    REAL,
  aqi_max     INTEGER,
  sample_n    INTEGER NOT NULL,
  PRIMARY KEY (station_id, date)
);
CREATE INDEX IF NOT EXISTS idx_sdaily_id_date ON station_daily (station_id, date DESC);
