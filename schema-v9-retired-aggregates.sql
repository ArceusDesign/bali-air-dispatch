-- schema-v9: retired town-level aggregates (additive; safe to re-run)
--
-- Every station_id beginning "iq-" came from IQAir's `nearest_city` endpoint:
-- a whole-town value, never a device. They were withdrawn from every published
-- surface on 2026-09-11 (DATA-METHODOLOGY.md 8.5) and their rows moved out of
-- stations / station_snapshots / station_daily into the three tables below,
-- which nothing in functions/ or workers/ reads. The columns and keys mirror
-- the live tables exactly, plus `retired_at` and `reason` on the station row,
-- so the withdrawal stays auditable and reversible. The move itself is an
-- operator step (a dated JSONL export, copy, verify, delete, verify) and is
-- deliberately not part of any migration, deploy or test.
CREATE TABLE IF NOT EXISTS retired_stations (
  station_id  TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  type        TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  retired_at  INTEGER NOT NULL,
  reason      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retired_station_snapshots (
  station_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  pm25         REAL,
  pm10         REAL,
  pm1          REAL,
  aqi          INTEGER,
  temperature  REAL,
  humidity     REAL,
  station_till TEXT,
  pm25_raw     REAL,
  PRIMARY KEY (station_id, ts)
);
CREATE TABLE IF NOT EXISTS retired_station_daily (
  station_id  TEXT NOT NULL,
  date        TEXT NOT NULL,
  pm25_mean   REAL,
  pm25_min    REAL,
  pm25_max    REAL,
  pm25_p95    REAL,
  aqi_max     INTEGER,
  sample_n    INTEGER NOT NULL,
  PRIMARY KEY (station_id, date)
);
