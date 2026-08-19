-- ─────────────────────────────────────────────────────────────────────────────
-- v7 — administrative area for community reports (Making Sense Bali v3 feed)
-- Applied to production 2026-08-19. Additive, replayable, safe to re-run.
--
-- WHY. Upstream shipped a breaking v3 on 15 Aug 2026 which, to its credit,
-- addressed two of the three problems we reported: the test/junk records that
-- were reaching the published feed are gone (count 62 -> 46, pipeline bug
-- fixed), and coordinates are no longer exact — every report now carries the
-- centroid of its desa/kelurahan plus a `location_precision` field and an
-- `admin_area` object. Reports in the same desa share one identical coordinate
-- by design, and upstream asks integrators to render areas rather than points.
--
-- `desa` is therefore the authoritative grouping key (upstream notes `name` and
-- `locality` may carry a looser colloquial area), and is what the map groups by
-- and what any "where does burning recur" query should aggregate on. Storing it
-- means that analysis no longer depends on reverse-geocoding a centroid.
--
-- NOT ADDED: nothing here loosens the privacy posture. Coordinates are still
-- snapped on the way in, and the resident's free-text `description` is still
-- neither published nor collected — v3 scrubbed coordinates and times but left
-- the free text untouched, and 9 of 30 burning descriptions still name streets,
-- markets and businesses ("off Jalan Raya Semer... behind the school").
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE community_reports ADD COLUMN desa TEXT;
ALTER TABLE community_reports ADD COLUMN kecamatan TEXT;
ALTER TABLE community_reports ADD COLUMN kabupaten TEXT;
ALTER TABLE community_reports ADD COLUMN location_precision TEXT;

-- The hotspot query this table exists to answer.
CREATE INDEX IF NOT EXISTS idx_community_reports_desa ON community_reports(desa);
