const fs = require('fs');
const path = require('path');
const fontnik = require('fontnik');

const FONTS = {
  'Noto Sans Regular': 'fonts/NotoSans-Regular.ttf',
  'Noto Sans Bold': 'fonts/NotoSans-Bold.ttf',
  'Noto Sans Italic': 'fonts/NotoSans-Italic.ttf',
};

const OUT = 'out';
const RANGE_SIZE = 256;
const MAX_CODEPOINT = 65535; // full BMP, matches standard glyph server coverage

async function main() {
  for (const [name, file] of Object.entries(FONTS)) {
    const buf = fs.readFileSync(file);
    const dir = path.join(OUT, name);
    fs.mkdirSync(dir, { recursive: true });
    let count = 0;
    for (let start = 0; start <= MAX_CODEPOINT; start += RANGE_SIZE) {
      const end = start + RANGE_SIZE - 1;
      await new Promise((resolve, reject) => {
        fontnik.range({ font: buf, start, end }, (err, pbf) => {
          if (err) return reject(err);
          fs.writeFileSync(path.join(dir, `${start}-${end}.pbf`), pbf);
          count++;
          resolve();
        });
      });
    }
    console.log(name, '->', count, 'ranges written to', dir);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
