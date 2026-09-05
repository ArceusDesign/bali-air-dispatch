# D1 + Nafas Archive — Setup

This doc walks through standing up the Cloudflare D1 database and the scheduled archive worker that backs the Nafas historical timeline. **Nothing here touches the live site** until the final `wrangler pages deploy public` step, which you control.

## Prerequisites

You already have:
- `wrangler` CLI authenticated (`wrangler whoami` works)
- `baliair` Pages project deployed

You still need:
- D1 database created (below)
- The scheduled Worker deployed (below)
- The Pages project re-deployed with the D1 binding (below)

All Cloudflare-side. No third-party accounts.

---

## 1. Create the D1 database

```bash
cd "/Users/derek/Claude/Claude Code/RNDM/bali-air-quality"
wrangler d1 create bali-air-archive
```

Output will look like:

```
✅ Successfully created DB 'bali-air-archive'
[[d1_databases]]
binding = "ARCHIVE_DB"
database_name = "bali-air-archive"
database_id = "abc12345-6789-def0-1234-56789abcdef0"
```

**Copy the `database_id`.** Paste it into two files:
- `wrangler.toml` (project root) — replace `REPLACE_WITH_REAL_D1_ID`
- `workers/nafas-archive/wrangler.toml` — replace `REPLACE_WITH_REAL_D1_ID`

Both need the **same** ID — they share one database.

---

## 2. Apply the schema

```bash
# Remote (production D1):
wrangler d1 execute bali-air-archive --remote --file=./schema.sql

# Also run locally so `wrangler pages dev` + `wrangler dev` work for testing:
wrangler d1 execute bali-air-archive --local  --file=./schema.sql
```

Verify:

```bash
wrangler d1 execute bali-air-archive --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Should list `nafas_stations`, `nafas_snapshots`, `nafas_hourly`, `nafas_daily`, `archive_runs`.

---

## 3. Deploy the archive worker

```bash
cd workers/nafas-archive
wrangler deploy
```

This publishes `nafas-archive.<your-subdomain>.workers.dev` on a `*/15 * * * *` cron.

Set the manual-trigger secret:

```bash
wrangler secret put CRON_SECRET
# paste any long random string, e.g.  openssl rand -hex 32
```

Kick off a first-run backfill (pulls `/all` + 6 details + persists hourly + ~30 days of daily per station):

```bash
curl -H "X-Secret: <that same secret>" https://nafas-archive.<subdomain>.workers.dev/run
```

Response shape:

```json
{
  "ok": true,
  "ts": 1713400000,
  "stationsSeen": 6,
  "snapshots": 6,
  "hourly": 144,
  "daily": 180,
  "duration": 812
}
```

Sanity-check a station:

```bash
wrangler d1 execute bali-air-archive --remote \
  --command="SELECT uuid, name, pm25 FROM nafas_snapshots ORDER BY ts DESC LIMIT 10"
```

From here the cron takes over — a new snapshot per station every 15 min.

---

## 4. Re-deploy the Pages project with the D1 binding

`wrangler.toml` at the project root now declares the D1 binding for Pages. Pages picks up bindings at deploy time, so:

```bash
cd "/Users/derek/Claude/Claude Code/RNDM/bali-air-quality"
wrangler pages deploy public
```

Verify the binding appears in the dashboard under **Pages → baliair → Settings → Functions → D1 database bindings**. Should show `ARCHIVE_DB → bali-air-archive`.

(Alternatively: set the binding via the dashboard directly. The `wrangler.toml` is just in-repo reproducibility; the dashboard is the source of truth for Pages.)

Test the read endpoint:

```bash
# Catalog
curl https://baliair.pages.dev/api/history

# One station, 24h snapshots
curl "https://baliair.pages.dev/api/history?uuid=8683b1a2-80ff-41e4-86d0-a14a9ca0d0ee&range=24h"

# One station, daily aggregates
curl "https://baliair.pages.dev/api/history?uuid=8683b1a2-80ff-41e4-86d0-a14a9ca0d0ee&range=daily"
```

---

## 5. Ops

### Watch the archive runs

```bash
wrangler d1 execute bali-air-archive --remote --command="
  SELECT ts, stations_seen, snapshots_written, hourly_upserts, daily_upserts, duration_ms, ok, error
  FROM archive_runs ORDER BY ts DESC LIMIT 20
"
```

Healthy run: `ok=1`, `stations_seen=6`, `snapshots_written=6`, duration under 3 s.

### Disable the cron temporarily

Either comment out `[triggers]` in `workers/nafas-archive/wrangler.toml` and re-deploy, or delete the worker from the dashboard. Catalog and historical rows are retained.

### Blow it all away (nuclear)

```bash
wrangler d1 delete bali-air-archive       # destroys all stored history
wrangler delete --name nafas-archive      # removes the scheduled worker
```

Then re-run steps 1–3 to rebuild. The archive backfills its first 24h + ~30 days automatically from the Nafas API.

### Storage budget

6 stations × 96 snapshots/day = 576 rows/day in `nafas_snapshots`.
Plus ~6 × 24 = 144 hourly upserts/day and ~6 daily rows/day.
**Total: ~750 rows/day → ~275k rows/year.** D1 free tier is 5M rows — we're 2% of it. Safe.

---

## 6. Rollback

Everything we did is reversible with zero trace on the public site:

1. **UI**: no new UI is live yet — the monitor preview change is in `previews/`, not `public/`.
2. **API**: `functions/api/live.js` changes add a new source. If it misbehaves, the try/catch swallows the error and the response still contains PurpleAir + AQICN + Airly + OpenAQ + IQAir. No visitor-facing breakage.
3. **D1**: if you want to remove the archive entirely, step 5's nuclear delete wipes it. Pages continues to work (the D1 binding becomes unused).
4. **Previous Airly Nafas relabel**: that logic is gone from `functions/api/live.js`. Airly rows now report `source: 'Airly'` correctly. Any previously-cached Nafas-labelled Airly rows expire within `s-maxage=3600` (1 hour).

---

## 7. What NOT to commit to the repo

- `wrangler.toml` files with the **real** `database_id` filled in. Keep the `REPLACE_WITH_REAL_D1_ID` placeholder in git; fill in the ID on your machine only.
- `CRON_SECRET`. Use `wrangler secret put`.
- Nothing else — there are no API keys specific to Nafas (public endpoint, no auth).

To keep the filled-in `database_id` out of git without fighting wrangler, add a `.gitignore` rule like:

```
# local-only wrangler config with real D1 id
wrangler.local.toml
```

…and copy `wrangler.toml` → `wrangler.local.toml` once you've filled in the ID. `wrangler` honours whichever is present; the `.local` suffix is ignored by git.
