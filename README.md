# Bali Air Dispatch

A live, continuously archived record of PM2.5 across Bali, published at
**[baliairdispatch.com](https://baliairdispatch.com)**.

The project operates no sensors of its own. It aggregates eight independent
monitoring networks into one map and one archive, applies a single published
humidity correction where it is valid, and exposes everything through an open
read-only API. It exists because Bali's open-burning problem is real and, until
recently, unmeasured: there was no continuous public record to point at.

Everything here is written to be checked rather than trusted. If the site says
a number, the API can reproduce it, and [`DATA-METHODOLOGY.md`](DATA-METHODOLOGY.md)
says how it was arrived at and what it does not claim.

## What it does

- **Live map** of every station reporting in the last few hours, with the
  island-wide median, the worst reading right now, and the WHO exceedance
  ratio computed only from sensors that are believed to be measuring ambient
  outdoor air.
- **Archive** every 15 minutes into a Cloudflare D1 database — snapshots, and
  daily rollups per station. Some stations carry a record back to November 2024.
- **History page** with multi-station overlay charts and honest gaps: a period
  with no data is drawn as no data, never bridged or filled.
- **Public API** at `/api/v1` — JSON and CSV, documented on the site's
  [API page](https://baliairdispatch.com/api).
- **Community sensor ingest** — a resident can run their own hardware and push
  readings in with a bearer token. The first contributed sensor is the only
  monitor in East Bali.
- **Burning-reports layer** from the Making Sense Bali community mapping
  project.
- **Self-hosted basemap** rendered from OpenStreetMap and served from R2, so a
  page load makes no third-party requests.

## Data sources

| Network | How it is read |
|---|---|
| Nafas | Public JSON feed (no key) |
| AirGradient | Public feed; humidity-corrected (see methodology §6) |
| OpenAQ | API key; used to pair and de-duplicate AirGradient relays |
| PurpleAir | API key; humidity-corrected |
| AQICN / GAIA | Free token |
| IQAir | API key for the AirVisual API; a separate optional worker renders public IQAir station pages that are not on any API |
| Smart Citizen | Public API (no key) |
| Community | Pushed to `POST /api/ingest` by the sensor owner |

Every reading originates from one of these networks and remains subject to
that network's terms. The humidity correction is the US EPA / Barkjohn formula
and is applied **only** to Plantower-based sensors it was fitted for; the
methodology document explains why it is deliberately not applied elsewhere.

## Architecture

```
public/                 static site (Cloudflare Pages)
functions/              Pages Functions — the API layer
  api/live.js             aggregator: D1 fast path + upstream fan-out, edge-cached
  api/history.js          per-station and catalog history
  api/v1/[[path]].js      public read-only API (JSON/CSV)
  api/ingest.js           community sensor POST endpoint
  api/reports.js          burning-reports layer
  tiles/[[path]].js       basemap tiles from R2
  _middleware.js          canonical-domain redirect (never for /api/*)
workers/
  nafas-archive/          cron */15: archives every station into D1, daily rollups
  iqair-scrape/           cron, optional: renders IQAir pages via Firecrawl
schema.sql, schema-v*.sql   D1 schema and additive migrations, in order
scripts/basemap/        OSM → Planetiler → MapLibre raster tile pipeline
scripts/generate-favicons.py
previews/               design explorations, not deployed
DATA-METHODOLOGY.md     the technical reference — read this first
D1-SETUP.md             standing up the database and archive worker
```

The two workers watch each other: each one checks whether the other's cron has
gone quiet and revives it through a service binding. A change to either should
keep that reciprocal property intact.

## Running it locally

You need [Wrangler](https://developers.cloudflare.com/workers/wrangler/) and
a Cloudflare account. Nothing else is required to run the site against a local
database:

```bash
# local D1 with the full schema
wrangler d1 execute bali-air-archive --local --file schema.sql
for f in schema-v*.sql; do wrangler d1 execute bali-air-archive --local --file "$f"; done

# the site + API on http://localhost:8788
wrangler pages dev public --local
```

Upstream sources are fetched under `Promise.allSettled` and each one is
optional: a missing key or a failed network simply drops out of the response
rather than breaking it. Nafas and Smart Citizen need no key at all, so you
get live data out of the box. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
full list of environment variables and which components need them.

Copy `wrangler.toml.example` (and the two under `workers/`) to `wrangler.toml`
and fill in your own database ID if you deploy your own instance.

## Deploying

Deploys are deliberately manual — nothing deploys on merge:

```bash
wrangler pages deploy public               # the site and API
(cd workers/nafas-archive && wrangler deploy)
(cd workers/iqair-scrape  && wrangler deploy)
```

## Contributing

Pull requests are welcome, particularly for new sources, better siting
metadata, and anything that makes the record more honest. Please read
[`CONTRIBUTING.md`](CONTRIBUTING.md) first — the archive is the one
irreplaceable thing here, and there are a few rules that protect it.

Security reports: see [`SECURITY.md`](SECURITY.md).

## Licence

Code is MIT; see [`LICENSE`](LICENSE). The measurements are not ours to
license. Basemap data © OpenStreetMap contributors (ODbL), rendered with the
OpenMapTiles schema (CC-BY 4.0).
