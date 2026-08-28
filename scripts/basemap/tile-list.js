// Ported verbatim (same constants/formulas) from
// bali-air-quality/functions/tiles/[[path]].js so the pre-rendered tileset
// exactly matches what the Worker will ever be asked to serve.
const MIN_Z = 9;
const MAX_Z = 16;
const BALI = { south: -8.92, west: 114.35, north: -8.00, east: 115.75 };
const BOUNDS_PAD = 0.02;
const TILE_PX = 256;
const MAX_VIEWPORT_PX = 4096;
const SLACK_TILES = 2;

const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const overscanTiles = (spanTiles) =>
  Math.ceil(Math.max(0, (MAX_VIEWPORT_PX - spanTiles * TILE_PX) / 2) / TILE_PX) + SLACK_TILES;

function buildAllowed() {
  const latPad = Math.abs(BALI.south - BALI.north) * BOUNDS_PAD;
  const lonPad = Math.abs(BALI.west - BALI.east) * BOUNDS_PAD;
  const south = BALI.south - latPad, north = BALI.north + latPad;
  const west = BALI.west - lonPad, east = BALI.east + lonPad;

  const table = new Map();
  for (let z = MIN_Z; z <= MAX_Z; z++) {
    const n = 2 ** z;
    const coreX0 = lonToX(west, z), coreX1 = lonToX(east, z);
    const coreY0 = latToY(north, z), coreY1 = latToY(south, z);
    const mx = overscanTiles(coreX1 - coreX0 + 1);
    const my = overscanTiles(coreY1 - coreY0 + 1);
    table.set(z, {
      x0: Math.max(0, coreX0 - mx), x1: Math.min(n - 1, coreX1 + mx),
      y0: Math.max(0, coreY0 - my), y1: Math.min(n - 1, coreY1 + my),
    });
  }
  return table;
}

function* allTiles() {
  const allowed = buildAllowed();
  for (const [z, win] of allowed) {
    for (let x = win.x0; x <= win.x1; x++) {
      for (let y = win.y0; y <= win.y1; y++) {
        yield { z, x, y };
      }
    }
  }
}

module.exports = { buildAllowed, allTiles };

if (require.main === module) {
  const allowed = buildAllowed();
  let total = 0;
  for (const [z, win] of allowed) {
    const n = (win.x1 - win.x0 + 1) * (win.y1 - win.y0 + 1);
    total += n;
    console.log(`z=${z}  x ${win.x0}..${win.x1}  y ${win.y0}..${win.y1}   ${n} tiles`);
  }
  console.log('TOTAL', total, 'base tiles (x2 for @2x =', total * 2, ')');
}
