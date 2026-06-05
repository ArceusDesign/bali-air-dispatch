-- IQAir scraped-station archive (separate tables; never touches the live
-- `stations`/`station_snapshots`/`station_daily` pipeline).
--
-- Source: Firecrawl renders each IQAir station page; we decode the page's own
-- React-Router stream payload (NOT the paywalled API) to get current PM2.5 +
-- the page's hourly (48h), daily (30d) and monthly (12mo) history.
--
-- All PM2.5 values are µg/m³. Timestamps are ISO-8601 UTC strings exactly as
-- IQAir publishes them (hourly: on the hour; daily/monthly: midnight UTC of the
-- period start — these are PERIOD AVERAGES, surfaced as such on the history UI).

-- One row per station (identity + latest snapshot for the live map).
CREATE TABLE IF NOT EXISTS iq_scrape_stations (
  slug            TEXT PRIMARY KEY,         -- stable url slug, e.g. 'rock-n-love-3'
  iqair_url       TEXT NOT NULL,
  name            TEXT,                     -- as published by IQAir
  lat             REAL,
  lon             REAL,
  source_type     TEXT,                     -- e.g. 'Source'
  source_subtype  TEXT,                     -- e.g. 'Corporate'
  contributor     TEXT,                     -- contributor display name
  latest_pm25     REAL,                     -- µg/m³
  latest_aqi      INTEGER,                  -- US AQI
  latest_ts       TEXT,                     -- ISO UTC of latest hourly point
  last_scrape_ts  INTEGER,                  -- unix seconds of our last scrape
  last_scrape_ok  INTEGER DEFAULT 0,        -- 1 if last scrape parsed cleanly
  first_seen      INTEGER,
  active          INTEGER DEFAULT 1
);

-- Hourly points (48h window per scrape; UPSERT de-dupes by (slug, ts)).
CREATE TABLE IF NOT EXISTS iq_scrape_hourly (
  slug          TEXT NOT NULL,
  ts            TEXT NOT NULL,             -- ISO UTC, on the hour
  pm25          REAL,                      -- µg/m³
  aqi           INTEGER,
  PRIMARY KEY (slug, ts)
);

-- Daily averages (30d window per scrape).
CREATE TABLE IF NOT EXISTS iq_scrape_daily (
  slug          TEXT NOT NULL,
  date          TEXT NOT NULL,             -- ISO UTC midnight (period start)
  pm25          REAL,                      -- µg/m³, daily average
  aqi           INTEGER,
  PRIMARY KEY (slug, date)
);

-- Monthly averages (12mo window per scrape).
CREATE TABLE IF NOT EXISTS iq_scrape_monthly (
  slug          TEXT NOT NULL,
  month         TEXT NOT NULL,            -- ISO UTC midnight (month start)
  pm25          REAL,                     -- µg/m³, monthly average
  aqi           INTEGER,
  PRIMARY KEY (slug, month)
);

-- One row per cron run — operational visibility so a stalled scraper is
-- diagnosable without a manual trigger (ok/fail/skip counts + per-station detail).
CREATE TABLE IF NOT EXISTS iq_scrape_runs (
  ts            INTEGER PRIMARY KEY,         -- unix seconds the run started
  duration_ms   INTEGER,
  ok_count      INTEGER,
  fail_count    INTEGER,
  skip_count    INTEGER,                     -- stations not started before the soft deadline
  detail        TEXT                         -- JSON: ["slug:ok","slug:http429",…]
);

CREATE INDEX IF NOT EXISTS idx_iq_hourly_slug_ts  ON iq_scrape_hourly  (slug, ts);
CREATE INDEX IF NOT EXISTS idx_iq_daily_slug_date ON iq_scrape_daily   (slug, date);
