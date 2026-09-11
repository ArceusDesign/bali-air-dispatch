-- schema-v10: a record, inside the database, of every deliberate change to
-- archived rows (additive; safe to re-run).
--
-- The archive's rule is that a reading, once written, is never rewritten.
-- Twice that rule has had to yield to a bug in how a reading was written in
-- the first place (the Plantower humidity correction, and AQICN's AQI
-- sub-index stored as µg/m³), and each time the change was applied by an
-- operator script outside the repository. This table makes those changes
-- visible to anyone querying the database, and lets the scripts refuse to
-- apply the same correction twice.
CREATE TABLE IF NOT EXISTS archive_corrections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at   INTEGER NOT NULL,   -- unix seconds UTC
  kind         TEXT    NOT NULL,   -- e.g. 'aqicn_index_to_ugm3'
  station_id   TEXT,               -- NULL when a correction spans stations
  rows_changed INTEGER NOT NULL,
  before_ts    INTEGER,            -- rows with ts < before_ts were changed
  note         TEXT    NOT NULL    -- what was done, and the pointer to why
);
