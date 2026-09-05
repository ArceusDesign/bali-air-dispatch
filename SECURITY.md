# Security policy

## Reporting a vulnerability

Email **baliair@protonmail.com**. Please do not open a public issue for
anything you believe is exploitable.

You will get an acknowledgement within 72 hours and a fix or a clear
explanation within 30 days for anything confirmed. If you want credit in the
changelog, say so; if you want to stay anonymous, that is equally fine.

## What is in scope

- The deployed site and API at `baliairdispatch.com` (Cloudflare Pages
  Functions under `functions/`).
- The two Cloudflare Workers under `workers/`.
- The community sensor ingest endpoint, `POST /api/ingest`.
- Anything that could alter, delete or fabricate rows in the archive
  database. The archive is the one thing this project treats as
  irreplaceable, so a write-path bug is the most serious class of report.

## What is out of scope

- The upstream monitoring networks the service reads from. Report those to
  the network concerned.
- Rate-limit findings on the public read API that amount to "it can be
  called a lot". It is edge-cached and read-only by design.
- Findings that require a contributor's own bearer token. Tokens are stored
  only as SHA-256 hashes; possession of the database does not let anyone post.

## Design notes worth knowing before you look

- Ingest tokens are never stored, logged or echoed; bad, unknown and revoked
  tokens all return an identical 401 so the endpoint cannot be used as an
  oracle.
- Timestamps on ingested readings are clamped to a narrow window around
  "now", so a token cannot be used to rewrite history.
- The archive tables use `INSERT OR IGNORE` on a `(station_id, ts)` primary
  key: a contributor can append, never overwrite.
- API keys for upstream networks live only as Cloudflare secrets. None have
  ever been committed; the full git history has been audited for this.
