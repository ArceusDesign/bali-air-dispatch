# Contributing

Thanks for looking. This is a small public-interest project and help is
genuinely welcome. A few things are non-negotiable because they protect the
one asset that cannot be rebuilt: the archive.

## The rules that matter

1. **Never run a write against the production database from a pull request,
   a script, or a test.** All development happens against a local D1
   (`wrangler … --local`). The archive has been damaged once by a well-meaning
   rollup change; it will not happen again through this repo.
2. **An honest gap beats a confident-but-wrong number.** A missing reading is
   a gap. It is never a zero, never interpolated, never bridged in a chart,
   and never a stale value presented as current. If you find a place that
   violates this, that is a bug worth a PR.
3. **Every upstream source must degrade, never block.** Fetchers run under
   `Promise.allSettled` with a timeout. A source that is down is absent from
   the response; it does not take the endpoint with it.
4. **Corrections are applied only where they were validated.** The EPA
   humidity correction is for Plantower-based sensors. Do not extend it to
   another sensor family without co-location evidence — see
   `DATA-METHODOLOGY.md` §6 and the `has_rh` gate in `functions/api/ingest.js`.
5. **Deploys stay manual.** Merging to `main` changes nothing in production.
   That is a feature.

## Getting set up

```bash
npm install -g wrangler
wrangler login

# Local database with the schema, in order
wrangler d1 execute bali-air-archive --local --file schema.sql
for f in schema-v*.sql; do wrangler d1 execute bali-air-archive --local --file "$f"; done

# Site + API
wrangler pages dev public --local        # http://localhost:8788

# Either worker, from its own directory
cd workers/nafas-archive && wrangler dev --local
```

`wrangler.toml` files are committed with the production database ID. For your
own instance, copy the `.example` files and substitute your own.

## Environment variables and secrets

None of these are in the repository, and none ever have been. In production
they are Cloudflare secrets. Locally, put them in a `.dev.vars` file (already
git-ignored by Wrangler convention).

| Component | Variable | Needed for |
|---|---|---|
| `functions/` | `PURPLEAIR_API_KEY` | PurpleAir stations |
| | `OPENAQ_API_KEY` | OpenAQ relays (pairing/de-dup of AirGradient) |
| | `AQICN_TOKEN` | AQICN / GAIA (free) |
| | `IQAIR_API_KEY` | IQAir AirVisual API |
| | `AIRLY_API_KEY` | Airly |
| `workers/nafas-archive` | `LIVE_ORIGIN` | origin of `/api/live` to archive from (defaults sensibly) |
| | `CRON_SECRET` | gates the manual `/run` trigger |
| | `IQAIR_WATCHDOG_KEY`, `ARCHIVE_WATCHDOG_KEY` | shared secrets between the two workers |
| `workers/iqair-scrape` | `FIRECRAWL_KEY` | rendering IQAir station pages (paid service) |
| | `IQAIR_WATCHDOG_KEY`, `ARCHIVE_WATCHDOG_KEY` | as above |

**You do not need any of these to contribute.** Nafas and Smart Citizen need
no key, so `/api/live` returns real data locally with nothing configured.
Front-end, history-page, API and documentation work needs no keys at all. The
full set only matters if you want to run a complete replica of the pipeline.
`iqair-scrape` in particular depends on a paid service and is optional; the
rest of the system runs without it.

## Making a change

- Branch from `main`; open a pull request. `main` is protected: it requires a
  review from a code owner (`.github/CODEOWNERS`) and cannot be pushed to
  directly.
- Keep commits focused. Commit messages in this repo explain **why** — what
  was wrong, what evidence showed it, what the change does and does not do.
  Read a few in `git log` for the house style; a message that only restates
  the diff will be asked to say more.
- If your change touches anything that writes to D1, say in the PR how you
  verified it against a local database and what it would have done to the
  existing rows.
- If it touches `/api/live`, note what it does to the number of D1 queries per
  request. That endpoint is edge-cached and cheap on the fast path by design,
  and it has been the source of two outages when it stopped being so.
- Front-end pages are plain HTML/JS with no build step. Keep it that way
  unless there is a strong reason.

## Adding a new data source

New sources are the most valuable contribution. The pattern in
`functions/api/live.js` is: one `fetchXxx(env)` function returning an array of
station objects, registered in the fetcher list, wrapped so it cannot throw.
Please also:

- give it a `SOURCE_STALE_MS` entry if its cadence is not hourly-ish;
- decide, and document, whether the EPA correction applies (only if it is a
  Plantower-based sensor and you have the raw `cf_1`-equivalent input);
- add a row to the sources table in `README.md` and a section in
  `DATA-METHODOLOGY.md`.

## Reporting problems

Bugs and questions: open an issue. Anything security-related: see
`SECURITY.md` and email instead.
