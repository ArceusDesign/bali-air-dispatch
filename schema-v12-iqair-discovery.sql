-- schema-v12: IQAir station discovery (additive; safe to re-run).
--
-- workers/iqair-scrape finds IQAir stations in Bali that are not on its seed
-- list and admits the ones that prove they are one native IQAir device (see
-- workers/iqair-scrape/src/discover.js). Until this file is applied the worker
-- simply skips discovery and scrapes its seed list, as before.
--
-- Operator overrides, by hand:
--   keep a station out for good:   UPDATE iq_discovery SET status = 'blocked' WHERE key = '<city>/<station>';
--   and take it off the map:       UPDATE iq_scrape_stations SET active = 0 WHERE slug = '<slug>';
--   admit one discovery rejected:  UPDATE iq_discovery SET status = 'active', slug = '<slug>' WHERE key = '…';
--                                  (slug: lower-case a-z, 0-9 and '-' only, unused; the id becomes 'iqs-' || slug)
--   force a full sweep tonight:    UPDATE iq_discovery_cities SET last_scanned = 0;

-- One row per IQAir station page discovery has seen that is not on the seed list.
CREATE TABLE IF NOT EXISTS iq_discovery (
  key          TEXT PRIMARY KEY,           -- '<city>/<station>' exactly as in IQAir's URL, decoded, lower-case
  url          TEXT NOT NULL,              -- the page the scraper reads
  slug         TEXT UNIQUE,                -- set on admission; the station's id is 'iqs-' || slug
  status       TEXT NOT NULL DEFAULT 'candidate',
                                           -- candidate | active | review | rejected | blocked
  reason       TEXT,                       -- why rejected: aggregate_page, relay, colocated, not_reporting, …
  detail       TEXT,                       -- e.g. 'AirGradient via OpenAQ', 'ag-204792 194 m'
  name         TEXT,
  lat          REAL,
  lon          REAL,
  contributor  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER NOT NULL,           -- unix seconds
  checked_at   INTEGER,
  decided_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_iq_discovery_status ON iq_discovery (status, checked_at);

-- IQAir's Bali "cities" (most are its own area estimates, never ingested): only
-- read to find the station links on them. Weekly, or at once when the count moves.
CREATE TABLE IF NOT EXISTS iq_discovery_cities (
  city          TEXT PRIMARY KEY,
  last_scanned  INTEGER NOT NULL DEFAULT 0,   -- 0 = due now
  stations_seen INTEGER
);

-- One row per discovery pass, so a stalled or noisy discovery is visible.
CREATE TABLE IF NOT EXISTS iq_discovery_runs (
  id                 INTEGER PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  duration_ms        INTEGER,
  state_count        INTEGER,                 -- IQAir's "N stations" for Bali, when read this pass
  cities_scanned     INTEGER,
  candidates_checked INTEGER,
  added              INTEGER,
  detail             TEXT                     -- JSON array of log lines
);
CREATE INDEX IF NOT EXISTS idx_iq_discovery_runs_ts ON iq_discovery_runs (ts);
