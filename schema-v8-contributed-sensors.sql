-- ─────────────────────────────────────────────────────────────────────────────
-- v8 — community-contributed sensors (direct push)
-- Applied to production 2026-08-19. Additive, replayable, safe to re-run.
--
-- WHY. Every other source on this site is PULLED: we poll a public network's
-- API on a schedule. This is the first PUSHED source — a resident runs their
-- own hardware and POSTs readings to us. The first contributor runs two Winsen
-- ZH03B units in Amed, which matters because the network currently has ZERO
-- stations east of longitude 115.55: the nearest monitor to Amed is ~36 km
-- away, so all of East Bali is unmeasured.
--
-- WHY REUSE THE UNIVERSAL TABLES. Readings land in `stations` +
-- `station_snapshots`, exactly like every pulled source, rather than in a
-- private table of their own. That is deliberate: /api/live's fast path, the
-- daily rollup, the history page, and the whole public /api/v1 surface all key
-- off those two tables, so a contributed sensor gets charting, archiving,
-- CSV export and API access with no extra code and no second code path to keep
-- in sync. `source` = 'Community' and the `cs-` id prefix are what distinguish
-- them downstream.
--
-- WHAT THIS TABLE IS. Only the credential and the policy for each contributor.
-- No readings live here.
--
-- TOKENS ARE NEVER STORED. `token_sha256` holds the SHA-256 of the bearer
-- token, hex-encoded; the token itself exists only in the contributor's device
-- config. A read of this table therefore does not let anyone post as them, and
-- we cannot recover a lost token — it gets rotated, not looked up.
--
-- TRUST POSTURE. A contributed reading is unverified by construction: we did
-- not site the device, cannot inspect it, and cannot audit its firmware. So
-- `cs-` stations are shown on the map and published through the API from day
-- one, but are excluded from the island-wide statistics (median, worst-now,
-- WHO exceedance ratio) until siting is settled — those figures are health
-- claims about ambient air, and the same reasoning already excludes
-- suspected-indoor sensors. See isAmbient() in public/index.html.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contrib_sensors (
  station_id     TEXT PRIMARY KEY,   -- 'cs-<slug>', joins stations/station_snapshots
  token_sha256   TEXT NOT NULL UNIQUE, -- hex SHA-256 of the bearer token; never the token
  name           TEXT NOT NULL,      -- display name on the map
  lat            REAL NOT NULL,
  lon            REAL NOT NULL,
  sensor_type    TEXT,               -- e.g. 'Winsen ZH03B'
  -- 1 only when a humidity sensor is confirmed CO-LOCATED with the PM sensor.
  -- Gates the US-EPA humidity correction: applying it with RH borrowed from
  -- another device or another site produces a confidently wrong number, which
  -- is worse than publishing the raw value and saying so. Default 0 = publish
  -- raw, flagged uncorrected.
  has_rh         INTEGER NOT NULL DEFAULT 0,
  -- Server-enforced floor between accepted posts. Contributors typically
  -- sample far faster than we need (the first one reads every ~10 s); this
  -- bounds D1 write volume and makes the cadence explicit rather than implicit.
  min_interval_s INTEGER NOT NULL DEFAULT 60,
  active         INTEGER NOT NULL DEFAULT 1,  -- 0 revokes the token instantly
  created_at     INTEGER NOT NULL,
  -- last_post_ts is not bookkeeping: the rate limit is enforced as a single
  -- conditional UPDATE against this column, so the database itself makes the
  -- decision. A read-then-check in the Worker would be a TOCTOU race —
  -- Functions run concurrently across isolates with no lock between two D1
  -- round trips, so every concurrent request would read the same stale value
  -- and all would pass.
  last_post_ts   INTEGER,            -- last ACCEPTED post; IS the rate-limit gate
  post_count     INTEGER NOT NULL DEFAULT 0,
  -- Retained but NO LONGER WRITTEN. It previously incremented on every 429,
  -- which made the rate limiter a 1:1 request-to-write amplifier against a D1
  -- instance shared with the archive workers — and D1's write quota is far
  -- tighter than its read quota, so a flood would have exhausted writes and
  -- stopped the curated 15-minute snapshots committing. A rejected request must
  -- cost nothing. Kept as a column so the schema stays additive; if abuse
  -- accounting is wanted later it belongs somewhere that isn't the archive DB.
  reject_count   INTEGER NOT NULL DEFAULT 0
);

-- The lookup every ingest request performs, on the hash and nothing else.
CREATE INDEX IF NOT EXISTS idx_contrib_token ON contrib_sensors(token_sha256);
