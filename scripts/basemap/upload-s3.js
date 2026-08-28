// Parallel uploader for the pre-rendered Bali tileset -> Cloudflare R2, via
// R2's S3-compatible DATA-plane API.
//
// Why not the Cloudflare REST API (see upload-r2.js): that is the control
// plane, globally rate-limited to ~1200 requests / 5 min. At 136k objects that
// is ~9.4 hours and it 429s hard under any real concurrency. The S3 endpoint
// is the data plane and has no such ceiling.
//
// Credentials come from the environment, never from a file in the repo:
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//
// Resumable: every successful key is appended to uploaded.log and skipped on
// a re-run.
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { allTiles } = require('./tile-list');

// Account id is not a secret (it appears in R2 endpoint URLs), but it is an
// identifier for an account that is deliberately not linked to this project,
// so it comes from the environment rather than the repo.
const ACCT = process.env.CF_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET || 'baliair-tiles';
// Build workspace. Override with BASEMAP_ROOT.
const ROOT = process.env.BASEMAP_ROOT || path.resolve(__dirname, '../../../BaliTiles');
const OUT_DIR = path.join(ROOT, 'out');
const DONE_LOG = path.join(ROOT, 'uploaded.log');

const CONCURRENCY = Number(process.env.CONCURRENCY || 96);
const MAX_RETRIES = 5;

const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey || !ACCT) {
  console.error('Set CF_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment.');
  process.exit(2);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 1, // retries handled below so backoff + logging are ours
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function putWithRetry(key, file) {
  const body = fs.readFileSync(file);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: 'image/png',
      }));
      return;
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      await sleep(Math.min(500 * 2 ** (attempt - 1), 10000));
    }
  }
}

async function main() {
  const work = [];
  for (const { z, x, y } of allTiles()) {
    work.push({ key: `${z}/${x}/${y}.png`, file: path.join(OUT_DIR, String(z), String(x), `${y}.png`) });
    work.push({ key: `${z}/${x}/${y}@2x.png`, file: path.join(OUT_DIR, String(z), String(x), `${y}@2x.png`) });
  }

  const done = new Set();
  if (fs.existsSync(DONE_LOG)) {
    for (const line of fs.readFileSync(DONE_LOG, 'utf8').split('\n')) if (line) done.add(line);
  }
  const todo = work.filter((w) => !done.has(w.key));
  console.log(`total ${work.length}, already uploaded ${done.size}, to upload ${todo.length}`);
  if (!todo.length) return console.log('nothing to do');

  const doneStream = fs.createWriteStream(DONE_LOG, { flags: 'a' });
  let idx = 0, completed = 0, failed = 0;
  const t0 = Date.now();

  async function worker() {
    while (idx < todo.length) {
      const { key, file } = todo[idx++];
      try {
        await putWithRetry(key, file);
        doneStream.write(key + '\n');
        completed++;
      } catch (e) {
        failed++;
        if (failed < 20) console.error(`FAIL ${key}: ${e.name}: ${e.message}`);
      }
      const n = completed + failed;
      if (n % 2000 === 0) {
        const elapsed = (Date.now() - t0) / 1000;
        const rate = completed / elapsed;
        console.log(
          `${n}/${todo.length}  ${rate.toFixed(0)}/s  ` +
          `eta ${(((todo.length - n) / rate) / 60).toFixed(1)}min  failed:${failed}`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  doneStream.end();

  console.log(`DONE in ${((Date.now() - t0) / 60000).toFixed(1)}min — uploaded ${completed}, failed ${failed}`);
  if (failed) {
    console.log('Re-run to retry failures (already-uploaded keys are skipped).');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
