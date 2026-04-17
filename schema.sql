-- D1 schema for Nafas historical archive
-- Apply with:
--   wrangler d1 execute bali-air-archive --file=./schema.sql --remote
-- Or locally (in .wrangler/state/):
--   wrangler d1 execute bali-air-archive --file=./schema.sql --local

-- ── Stations catalog ───────────────────────────────────────────────────────
-- One row per Nafas station we've ever observed in the /location/all feed,
-- filtered to the Bali bounding box. Kept separate from the readings tables
-- so we can join for name/coords without duplicating metadata on every row.
CREATE TABLE IF NOT EXISTS nafas_stations (
  uuid        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  sponsor     TEXT,
  vendor      TEXT,
  first_seen  INTEGER NOT NULL,   -- unix seconds (UTC), first time we observed it
  last_seen   INTEGER NOT NULL    -- unix seconds (UTC), last time we confirmed it
);

-- ── Live snapshots ─────────────────────────────────────────────────────────
-- Append-only log of every reading we pull (every 15 min by default).
-- Gives us sub-hourly resolution the Nafas API doesn't expose.
-- PRIMARY KEY (uuid, ts) means re-runs of the same tick are idempotent.
CREATE TABLE IF NOT EXISTS nafas_snapshots (
  uuid         TEXT NOT NULL,
  ts           INTEGER NOT NULL,  -- unix seconds (UTC) when we fetched
  station_till TEXT,              -- Nafas "till" field at fetch time
  pm25         REAL,
  pm10         REAL,
  pm1          REAL,
  aqi          INTEGER,
  temperature  REAL,
  humidity     REAL,
  pressure     REAL,
  PRIMARY KEY (uuid, ts),
  FOREIGN KEY (uuid) REFERENCES nafas_stations(uuid)
);
CREATE INDEX IF NOT EXISTS idx_snap_uuid_ts  ON nafas_snapshots (uuid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_snap_ts       ON nafas_snapshots (ts DESC);

-- ── Hourly aggregates (authoritative: mirrors Nafas's own hourly table) ────
-- Nafas exposes their own hourly rollup via detail.measurement.hourly[].
-- We persist it verbatim so we don't lose data past their ~24h window.
CREATE TABLE IF NOT EXISTS nafas_hourly (
  uuid        TEXT NOT NULL,
  hour_start  TEXT NOT NULL,      -- ISO "from" timestamp (Asia/Makassar, WITA +08:00)
  pm25        REAL,
  pm10        REAL,
  pm1         REAL,
  aqi         INTEGER,
  temperature REAL,
  humidity    REAL,
  pressure    REAL,
  PRIMARY KEY (uuid, hour_start),
  FOREIGN KEY (uuid) REFERENCES nafas_stations(uuid)
);
CREATE INDEX IF NOT EXISTS idx_hourly_uuid_time ON nafas_hourly (uuid, hour_start DESC);

-- ── Daily aggregates (authoritative: mirrors Nafas's own daily table) ─────
-- Nafas returns ~30 days of daily aggregates via detail.measurement.daily[].
-- We persist these so that history beyond their 30-day window isn't lost.
CREATE TABLE IF NOT EXISTS nafas_daily (
  uuid        TEXT NOT NULL,
  date        TEXT NOT NULL,      -- YYYY-MM-DD (Asia/Makassar)
  pm25        REAL,
  pm10        REAL,
  pm1         REAL,
  aqi         INTEGER,
  temperature REAL,
  humidity    REAL,
  pressure    REAL,
  PRIMARY KEY (uuid, date),
  FOREIGN KEY (uuid) REFERENCES nafas_stations(uuid)
);
CREATE INDEX IF NOT EXISTS idx_daily_uuid_date ON nafas_daily (uuid, date DESC);

-- ── Job log (for debugging the cron, optional but useful) ─────────────────
CREATE TABLE IF NOT EXISTS archive_runs (
  ts                   INTEGER PRIMARY KEY,  -- unix seconds (UTC) when run started
  stations_seen        INTEGER NOT NULL,
  snapshots_written    INTEGER NOT NULL,
  hourly_upserts       INTEGER NOT NULL,
  daily_upserts        INTEGER NOT NULL,
  duration_ms          INTEGER NOT NULL,
  ok                   INTEGER NOT NULL,     -- 1 success, 0 failure
  error                TEXT
);
