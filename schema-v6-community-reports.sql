-- ─────────────────────────────────────────────────────────────────────────────
-- v6 — community burning reports (Making Sense Bali)
-- Applied to production 2026-08-14. Follows the v2/v3/v4/v5 convention: purely
-- additive, replayable, and safe to re-run (IF NOT EXISTS throughout).
--
-- WHY. Making Sense Bali publishes moderated citizen reports of air-pollution
-- events (https://makingsense.fablabbali.com/, CC BY 4.0, contact
-- tomas@fab.city). We display only `pollution_category = "burning"` on the map.
-- The upstream feed is a rolling publication, not an archive: reports are
-- REMOVED when a resident revokes consent, and there is no historical endpoint.
-- Without our own copy there is no way to answer the question this data exists
-- to answer — where does burning recur, over months and years.
--
-- WHAT IS STORED. Only what we already publish on the map, and no more:
--   • `lat`/`lon` are SNAPPED to a ~275 m grid by functions/api/reports.js
--     before they ever reach this table. Upstream coordinates are 7-decimal
--     (building-level) despite the feed's own documentation describing them as
--     "neighbourhood-level, deliberate" — one recurring reporter's 11 reports
--     all land on a single exact point, which identifies a specific property
--     and, by inference, the neighbour reporting it. We never store, and never
--     publish, the upstream precision.
--   • The resident's free-text `description` is NOT collected. The column
--     exists (so this schema stays additive and the decision stays reversible)
--     but the worker always binds it to NULL. Live descriptions carry street
--     names, named businesses and self-identifying phrasing — 9 of 30 burning
--     reports on 2026-08-14, one of them "a recycling center next to our house
--     who is daily burning trash. I chatted with them today" — which would
--     re-identify precisely what the coordinate snapping above protects. What
--     IS kept is upstream's model-generated `ai_analysis.description`, which is
--     scene text ("smoke rising from a pile of trash") with no names or places.
--   • No photo bytes are stored HERE. functions/api/reports/[id].js proxies
--     them from upstream on demand. Note this is not the same as "never
--     stored anywhere": that proxy's responses sit in Cloudflare's edge cache
--     and in visitor browser caches for PHOTO_TTL_S (15 min), deliberately
--     short so a withdrawn photo stops being served about one archive tick
--     after upstream pulls it. `has_photo` records only whether one existed.
--   • Test/junk records are excluded upstream of this table by the content
--     heuristic in functions/api/reports.js (the published feed has been
--     observed carrying records reading "Test Telegram bot - do not approve."
--     with status "active" — see that file for the standing rationale).
--
-- CONSENT REVOCATION. When a report disappears from the upstream index, the
-- archive worker sets `revoked_at` and NULLs `description` + `ai_description`
-- — the two fields carrying a resident's own words. The row itself survives
-- with its coarse cell, date and category, so long-term geography of burning
-- is preserved without retaining content somebody withdrew. This is the whole
-- point of separating the two: the pattern is ours to keep, the words are not.
--
-- The revocation sweep is guarded (see reportsArchive in
-- workers/nafas-archive/src/index.js): it runs only when the upstream index
-- was fetched successfully AND the number of disappearances is plausible, so a
-- truncated or failed upstream response can never mass-erase descriptions.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS community_reports (
  report_id      TEXT PRIMARY KEY,   -- upstream filename stem, e.g. AQ_20260809_010146_734
  category       TEXT NOT NULL,      -- 'burning' — the only category we archive today
  lat            REAL NOT NULL,      -- SNAPPED (~275 m grid), never upstream precision
  lon            REAL NOT NULL,      -- SNAPPED (~275 m grid), never upstream precision
  locality       TEXT,               -- upstream locality label; often just "Bali"
  date_added     TEXT NOT NULL,      -- upstream ISO8601 timestamp of the report
  description    TEXT,               -- resident's own words — NULLED on revocation
  ai_description TEXT,               -- upstream AI photo reading — NULLED on revocation
  has_photo      INTEGER NOT NULL DEFAULT 0,  -- 1 = a photo existed upstream (bytes not stored)
  first_seen     INTEGER NOT NULL,   -- unix sec — first tick WE archived it
  last_seen      INTEGER NOT NULL,   -- unix sec — last tick we saw it still published
  revoked_at     INTEGER             -- unix sec it vanished upstream; NULL = still published
);

-- Time-series queries ("burning reports by month") and the recurrence analysis
-- this table exists for ("which cells burn repeatedly").
CREATE INDEX IF NOT EXISTS idx_community_reports_date ON community_reports(date_added);
CREATE INDEX IF NOT EXISTS idx_community_reports_cell ON community_reports(lat, lon);
