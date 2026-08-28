// ─────────────────────────────────────────────────────────────────────────────
// BASEMAP BUILD PIPELINE — step 6 of 7
//
// The map's tiles are OURS: rendered from OpenStreetMap and served from R2 by
// functions/tiles/[[path]].js. No third party sits in a visitor's request path,
// and no provider can gate, meter or withdraw the basemap. (CARTO ended keyless
// access on 26 Aug 2026 AND their T&C §9(c) forbids server-side proxying, so a
// free key would not have made the old architecture compliant.)
//
// Prereqs: `brew install openjdk osmium-tool`, Node 20+.
// Workspace: $BASEMAP_ROOT, default ../../../BaliTiles relative to this file.
//
//   1. OSM extract   Geofabrik indonesia-latest.osm.pbf (~1.7 GB)
//   2. Clip          osmium extract -b 107.28,-15.58,122.64,-1.10
//                    (the z9 OVERSCAN extent, not the tight Bali box — at z9 the
//                     viewport also shows Java and Lombok)
//   3. Vector tiles  Planetiler, openmaptiles profile, maxzoom 14 -> bali.mbtiles
//   4. Glyphs        generate-glyphs.js (fontnik, Noto Sans reg/bold/italic, BMP)
//   5. Sprite        fetched once from CARTO's open style assets
//   6. Raster render THIS FILE (MapLibre GL Native) -> ~136k PNGs (~1.7 GB)
//   7. Upload        upload-s3.js -> R2 bucket `baliair-tiles`
//
// AFTER ANY RE-RENDER, BUMP `TILESET_EPOCH` in functions/tiles/[[path]].js and
// redeploy. Tiles are served `immutable` with a 30-day edge TTL, so without a
// bump the old bytes stay pinned at the edge for up to a month — and worst of
// all for the busiest tiles, since those are the ones that got cached. Learned
// the hard way at the CARTO→R2 cutover, when "API KEY REQUIRED" placeholders
// survived the deploy.
//
// LICENCES — all three require visible credit, carried in the Leaflet
// attribution control and the page footer. Do not remove them.
//   OpenStreetMap data   ODbL       "© OpenStreetMap contributors". Rendered
//                                   images are a produced work: no share-alike.
//   OpenMapTiles schema  CC-BY      credit OpenMapTiles.
//   CARTO Voyager style  BSD-3 code / CC-BY 4.0 design — the STYLE is open even
//                                   though their tile SERVICE is not.
// ─────────────────────────────────────────────────────────────────────────────
// Renders a shard of the Bali tile list to PNG using one persistent
// maplibre-gl-native Map instance (style/sources loaded once), fed entirely
// from local files: the Planetiler mbtiles, locally generated glyph PBFs, and
// the downloaded Voyager sprite. No network access at render time.
//
// Usage: node render-worker.js <shardIndex> <shardCount>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const maplibre = require('@maplibre/maplibre-gl-native');
const MBTiles = require('@mapbox/mbtiles');
const sharp = require('sharp');
const { viewport: geoViewport } = require('@placemarkio/geo-viewport');
const { allTiles } = require('./tile-list');

// Build workspace. Override with BASEMAP_ROOT; defaults to a sibling of the
// repo so no absolute developer path is ever committed.
const ROOT = process.env.BASEMAP_ROOT || path.resolve(__dirname, '../../../BaliTiles');
const STYLE_PATH = path.join(ROOT, 'style/voyager-local.json');
const MBTILES_PATH = path.join(ROOT, 'mbtiles/bali.mbtiles');
const SPRITE_DIR = path.join(ROOT, 'style/sprite');
const GLYPH_DIR = path.join(ROOT, 'glyphgen/out');
const OUT_DIR = path.join(ROOT, 'out');

const TILE_REGEXP = /mbtiles:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/;
const GLYPH_REGEXP = /^glyphs:\/\/local\/([^/]+)\/(\d+)-(\d+)\.pbf$/;

function pickWeight(fontstack) {
  const decoded = decodeURIComponent(fontstack);
  if (/bold/i.test(decoded)) return 'Noto Sans Bold';
  if (/italic/i.test(decoded)) return 'Noto Sans Italic';
  return 'Noto Sans Regular';
}

let mbtiles = null;
function getMbtiles() {
  return new Promise((resolve, reject) => {
    if (mbtiles) return resolve(mbtiles);
    new MBTiles(MBTILES_PATH, (err, inst) => {
      if (err) return reject(err);
      mbtiles = inst;
      resolve(inst);
    });
  });
}

function requestHandler({ url, kind }, callback) {
  (async () => {
    try {
      // vector tile
      const tileMatch = url.match(TILE_REGEXP);
      if (tileMatch) {
        const [, , z, x, y] = tileMatch;
        const db = await getMbtiles();
        db.getTile(z, x, y, (err, data) => {
          if (err || !data) return callback(null, {});
          zlib.unzip(data, (uzErr, unzipped) => {
            if (uzErr) return callback(null, {});
            callback(null, { data: unzipped });
          });
        });
        return;
      }
      // vector source metadata (TileJSON)
      if (url === 'mbtiles://bali') {
        const db = await getMbtiles();
        db.getInfo((err, info) => {
          if (err) return callback(err);
          const tileJSON = {
            tilejson: '1.0.0',
            tiles: ['mbtiles://bali/{z}/{x}/{y}'],
            minzoom: info.minzoom,
            maxzoom: info.maxzoom,
          };
          callback(null, { data: Buffer.from(JSON.stringify(tileJSON)) });
        });
        return;
      }
      // sprite
      if (url.startsWith('sprite://local')) {
        const is2x = url.includes('@2x');
        const isJson = url.endsWith('.json');
        const file = path.join(SPRITE_DIR, `sprite${is2x ? '@2x' : ''}${isJson ? '.json' : '.png'}`);
        return callback(null, { data: fs.readFileSync(file) });
      }
      // glyphs
      const glyphMatch = url.match(GLYPH_REGEXP);
      if (glyphMatch) {
        const [, fontstack, start, end] = glyphMatch;
        const weight = pickWeight(fontstack);
        const file = path.join(GLYPH_DIR, weight, `${start}-${end}.pbf`);
        if (!fs.existsSync(file)) return callback(null, {});
        return callback(null, { data: fs.readFileSync(file) });
      }
      callback(new Error(`Unhandled request: ${url} (kind ${kind})`));
    } catch (e) {
      callback(e);
    }
  })();
}

// Standard slippy-tile -> lon/lat bounds (Web Mercator).
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = (xx) => (xx / n) * 360 - 180;
  const lat = (yy) => {
    const m = Math.PI - (2 * Math.PI * yy) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m)));
  };
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)]; // west, south, east, north
}

// Same -1 zoom correction mbgl-renderer applies for 256px-tile-scheme bounds
// rendering against mbgl-native's 512px-tile internal convention.
function zoomCenterFor(bounds, width, height) {
  const v = geoViewport(bounds, [width, height], { allowFloat: true });
  return { zoom: Math.max(v.zoom - 1, 0), center: v.center };
}

async function toPNG(buffer, width, height, ratio) {
  for (let i = 0; i < buffer.length; i += 4) {
    const alpha = buffer[i + 3];
    const norm = alpha / 255;
    if (alpha === 0) {
      buffer[i] = 0; buffer[i + 1] = 0; buffer[i + 2] = 0;
    } else {
      buffer[i] /= norm; buffer[i + 1] /= norm; buffer[i + 2] /= norm;
    }
  }
  return sharp(buffer, { raw: { width: width * ratio, height: height * ratio, channels: 4 } })
    .png()
    .toBuffer();
}

function renderOnce(map, options) {
  return new Promise((resolve, reject) => {
    map.render(options, (err, buffer) => (err ? reject(err) : resolve(buffer)));
  });
}

async function main() {
  const shardIndex = Number(process.argv[2] || 0);
  const shardCount = Number(process.argv[3] || 1);
  const style = JSON.parse(fs.readFileSync(STYLE_PATH, 'utf8'));

  // ratio is fixed at Map construction time in maplibre-gl-native (not a
  // per-render option), so two persistent instances share the same style and
  // local-file request handler but render at 1x and 2x pixel density.
  const map1x = new maplibre.Map({ request: requestHandler, ratio: 1 });
  map1x.load(style);
  const map2x = new maplibre.Map({ request: requestHandler, ratio: 2 });
  map2x.load(style);

  const all = [...allTiles()].filter((_, i) => i % shardCount === shardIndex);
  let done = 0;
  const t0 = Date.now();

  for (const { z, x, y } of all) {
    const bounds = tileBounds(z, x, y);
    const dir = path.join(OUT_DIR, String(z), String(x));
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${y}.png`);
    const retina = path.join(dir, `${y}@2x.png`);
    const { zoom, center } = zoomCenterFor(bounds, 256, 256);

    if (!fs.existsSync(base)) {
      const buf = await renderOnce(map1x, { zoom, center, width: 256, height: 256 });
      fs.writeFileSync(base, await toPNG(buf, 256, 256, 1));
    }
    if (!fs.existsSync(retina)) {
      const buf2 = await renderOnce(map2x, { zoom, center, width: 256, height: 256 });
      fs.writeFileSync(retina, await toPNG(buf2, 256, 256, 2));
    }

    done++;
    if (done % 200 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`[shard ${shardIndex}] ${done}/${all.length}  (${rate.toFixed(1)} tiles/s)`);
    }
  }
  console.log(`[shard ${shardIndex}] DONE: ${done} tiles`);
}

main().catch((e) => { console.error(e); process.exit(1); });
