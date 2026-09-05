# Self-hosted basemap — build pipeline

The map's basemap tiles are **ours**: rendered from OpenStreetMap data and served
from our own R2 bucket by `functions/tiles/[[path]].js`. No third party is in the
request path, so nothing about a reader's panning reaches anyone else, and no
provider can gate, meter or withdraw the basemap.

## Why we self-host

Until 27 Aug 2026 the tiles came from CARTO (`basemaps.cartocdn.com`), proxied
server-side so visitor IPs never reached them. On **26 Aug 2026** CARTO ended
keyless access — every anonymous request began returning a 200 PNG reading
"API KEY REQUIRED", cached at their edge for 180 days. Getting a free key would
not have fixed it: CARTO's Basemap T&C **§9(c) explicitly forbids "proxying or
caching the content on the server side"**, which is exactly what our privacy
design requires, and keys are revocable at their discretion without notice.

So the basemap became ours. Legally this is clean:

| Component | Licence | Obligation |
|---|---|---|
| OpenStreetMap data | ODbL | Credit "© OpenStreetMap contributors". Rendered images are a *produced work*, so no share-alike on the tiles. |
| OpenMapTiles schema | CC-BY | Visible credit to OpenMapTiles. |
| CARTO Voyager **style** | code BSD-3 / design CC-BY 4.0 | Visible credit to CARTO. The *style* is open source even though their *tile service* is not. |

All three are credited in the Leaflet attribution control and the page footer.
**Do not remove them.**

## Pipeline

Prerequisites: `brew install openjdk osmium-tool`, Node 20+.
Build workspace defaults to a `BaliTiles/` directory beside the repo; override with `BASEMAP_ROOT`.

```
1. OSM extract       Geofabrik indonesia-latest.osm.pbf  (~1.7 GB)
2. Clip              osmium extract -b 107.28,-15.58,122.64,-1.10
                     (the z9 overscan extent, not just the tight Bali box —
                      at z9 the viewport shows Java and Lombok too)
3. Vector tiles      Planetiler, openmaptiles profile, maxzoom 14  -> bali.mbtiles (~720 MB)
4. Glyphs            generate-glyphs.js  (fontnik, Noto Sans reg/bold/italic, full BMP)
5. Sprite            downloaded once from CARTO's open style assets
6. Raster render     render-worker.js  (MapLibre GL Native)  -> ~136k PNGs (~1.7 GB)
7. Upload            upload-s3.js      -> R2 bucket `baliair-tiles`
```

### Which tiles get rendered

`tile-list.js` is a **verbatim port** of the authorisation table in
`functions/tiles/[[path]].js` — same bbox, same padding, same overscan formula.
That is deliberate: the set we render and the set the Worker will serve are the
same fact, derived from one source. It produces **67,979 tiles** (z9–16), each
with a base and an `@2x` variant = **135,958 objects**.

If you change `BALI`, `MIN_Z`/`MAX_Z` or the overscan constants in the Worker,
change them in `tile-list.js` too and re-render, or the map gets holes.

### Uploading

The Cloudflare **REST** API (`wrangler r2 object put`) is the control plane and is
globally rate-limited to ~1200 req/5 min — that is ~9.4 hours for this tileset and
it 429s hard under concurrency. Use the **S3 data-plane** API instead (`upload-s3.js`),
which sustains ~175 objects/s and finishes in ~15 min.

Credentials come from the environment and must never be committed:

```bash
set -a; . ~/.r2-creds; set +a      # CF_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
CONCURRENCY=96 node scripts/basemap/upload-s3.js
```

Credentials and the account id come from the environment; nothing identifying is
committed. Keep `~/.r2-creds` at mode 600 and out of the repo.

The uploader is resumable — successful keys are appended to `uploaded.log` and
skipped on re-run, so an interruption costs only the remainder.

## Refreshing the tiles

**The tileset is a snapshot.** It reflects OSM as of the extract date and will
never change on its own — new roads and buildings in Bali will not appear until
someone re-runs this pipeline. That is the deliberate trade for having no live
dependency. Re-running the whole thing takes well under an hour, most of it
unattended; a yearly refresh is plenty for a basemap whose job is to sit behind
air-quality pins.

To refresh: delete `$BASEMAP_ROOT/out` and `$BASEMAP_ROOT/uploaded.log`, then re-run steps 1-7.
Uploading over existing keys is safe — R2 overwrites in place.

**Then bump `TILESET_EPOCH` in `functions/tiles/[[path]].js` and redeploy.** Tiles
are served `immutable` with a 30-day edge TTL, so without a bump the old bytes stay
pinned at the edge for up to a month — and specifically for the busiest tiles, since
those are the ones that got cached. The epoch is part of the cache key only; it never
appears in a public URL or an R2 key. This was learned the hard way at the CARTO→R2
cutover, when "API KEY REQUIRED" placeholders survived the deploy.
