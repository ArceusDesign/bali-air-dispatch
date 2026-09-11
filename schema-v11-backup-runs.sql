-- schema-v11: one row per run of the d1-backup worker (additive; safe to re-run).
--
-- workers/d1-backup copies every table of this database into R2 once a day
-- and records the outcome here, success or failure, so that a missed day is
-- visible from inside the database — which is what the operator's hourly
-- heartbeat reads to raise an alert. The worker also creates this table if it
-- is missing, so applying this file is belt and braces, not a prerequisite.
CREATE TABLE IF NOT EXISTS backup_runs (
  ts          INTEGER PRIMARY KEY,   -- unix seconds UTC when the run started
  ok          INTEGER NOT NULL,      -- 1 success, 0 failure
  tables      INTEGER NOT NULL,      -- tables copied
  rows        INTEGER NOT NULL,      -- rows copied, all tables
  bytes_gzip  INTEGER NOT NULL,      -- size of the day's objects in R2
  duration_ms INTEGER NOT NULL,
  error       TEXT                   -- NULL on success
);
