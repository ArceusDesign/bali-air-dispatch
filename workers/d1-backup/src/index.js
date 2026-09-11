// Bali Air Dispatch — daily copy of the whole archive database into R2.
//
// WHY THIS EXISTS. The archive (D1) is the one thing this project cannot
// rebuild. Until September 2026 its only copy outside D1 was a nightly dump
// taken on the operator's Mac by launchd, and a launchd job scheduled while
// the machine is switched off is simply skipped: 7 and 8 September 2026 had
// no backup because the Mac was off from the 6th to the 8th. A backup that
// depends on one laptop being awake is a floor, not a guarantee.
//
// This worker runs inside Cloudflare on a cron, reads every table through the
// D1 binding and writes it as gzipped JSONL under daily/YYYY-MM-DD/ in a
// private R2 bucket, then removes days older than RETENTION_DAYS. Bindings
// carry no credentials, so nothing here can leak a key, and no third party is
// involved. Cloudflare's own Time Travel already allows the database to be
// restored to any minute of the last 30 days; this is the copy that outlives
// that window, that a restore can be rebuilt from row by row, and that the
// Mac dump complements as the copy held OUTSIDE the Cloudflare account.
//
// Cost, on the Workers Paid plan: one full read of every table per day
// (about 300,000 rows), and a few tens of small R2 objects. Both are far
// inside the included quotas.
//
// Every run writes one row to backup_runs (schema-v11), whether it succeeded
// or not, so the operator's hourly heartbeat can page when a day is missed.
// If PUSHOVER_TOKEN / PUSHOVER_USER secrets are set, a failed run also sends
// a phone alert directly, with no Mac in the loop.

const PAGE = 5000;                     // rows per object; ~1 MB of JSONL before gzip
const RETENTION_DAYS = 90;             // daily/ prefixes older than this are deleted
const SKIP_TABLES = /^(sqlite_|_cf_)/; // SQLite's own, and D1's internal, tables

const RUNS_DDL = `CREATE TABLE IF NOT EXISTS backup_runs (
  ts          INTEGER PRIMARY KEY,
  ok          INTEGER NOT NULL,
  tables      INTEGER NOT NULL,
  rows        INTEGER NOT NULL,
  bytes_gzip  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error       TEXT
)`;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(backupOnce(env));
  },
  // No HTTP surface on purpose: this worker only ever runs on its cron, and
  // workers_dev is off in wrangler.toml, so there is no public URL to reach it.
  async fetch() {
    return new Response('not found', { status: 404 });
  },
};

async function backupOnce(env) {
  const t0 = Date.now();
  const day = new Date(t0).toISOString().slice(0, 10);
  const prefix = `daily/${day}/`;
  const manifest = {
    day, started_at: new Date(t0).toISOString(), page_rows: PAGE,
    tables: {}, rows: 0, parts: 0, bytes_gzip: 0,
  };
  let ok = 1, error = null;
  try {
    await env.ARCHIVE_DB.prepare(RUNS_DDL).run();
    const tables = (await env.ARCHIVE_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all()).results.map(r => r.name).filter(n => !SKIP_TABLES.test(n));
    if (!tables.length) throw new Error('no tables found');
    for (const table of tables) {
      const info = await dumpTable(env, table, prefix);
      manifest.tables[table] = info;
      manifest.rows += info.rows;
      manifest.parts += info.parts;
      manifest.bytes_gzip += info.bytes_gzip;
    }
    // Prune before writing the manifest so the manifest records it. A prune
    // failure is noted, never allowed to mark a completed copy as failed.
    try {
      manifest.pruned = await pruneOld(env.BACKUPS, day);
    } catch (e) {
      manifest.pruned = { error: (e && e.message) || String(e) };
      console.error('d1-backup: prune failed —', manifest.pruned.error);
    }
    manifest.finished_at = new Date().toISOString();
    manifest.duration_ms = Date.now() - t0;
    const body = JSON.stringify(manifest, null, 2);
    const meta = { httpMetadata: { contentType: 'application/json' } };
    await env.BACKUPS.put(prefix + 'manifest.json', body, meta);
    await env.BACKUPS.put('latest.json', body, meta);
    console.log(`d1-backup: ${day} ok — ${manifest.rows} rows, ${manifest.parts} objects, ` +
                `${Math.round(manifest.bytes_gzip / 1024)} KB gzipped, ${manifest.duration_ms} ms`);
  } catch (e) {
    ok = 0;
    error = (e && e.message) || String(e);
    console.error('d1-backup: FAILED —', error);
  }
  await logRun(env.ARCHIVE_DB, {
    ts: Math.floor(t0 / 1000), ok, tables: Object.keys(manifest.tables).length,
    rows: manifest.rows, bytes: manifest.bytes_gzip, duration_ms: Date.now() - t0, error,
  });
  if (!ok || manifest.rows === 0) await pushover(env, error || 'the run copied zero rows');
  return { ok, error, ...manifest };
}

// Walks one table in rowid order with an indexed range scan (never OFFSET,
// which re-reads everything before it). Every table in this schema is a
// rowid table, and for a table with an INTEGER PRIMARY KEY the rowid IS that
// key, so the walk is stable even if rows are inserted while it runs. Each
// page becomes one gzipped JSONL object, so memory never holds more than a
// page, and a restore can be rebuilt from the objects alone.
async function dumpTable(env, table, prefix) {
  const sql = `SELECT rowid AS _rid, * FROM "${table}" WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`;
  let last = 0, part = 0, rows = 0, bytes = 0;
  for (;;) {
    const page = (await env.ARCHIVE_DB.prepare(sql).bind(last, PAGE).all()).results;
    if (!page.length) break;
    last = page[page.length - 1]._rid;
    const text = page.map(r => { const { _rid, ...row } = r; return JSON.stringify(row); }).join('\n') + '\n';
    const plain = new TextEncoder().encode(text);
    const gz = await gzip(plain);
    const key = `${prefix}${table}/part-${String(part).padStart(5, '0')}.jsonl.gz`;
    await env.BACKUPS.put(key, gz, {
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { table, rows: String(page.length), sha256_plain: await sha256(plain) },
    });
    part += 1;
    rows += page.length;
    bytes += gz.byteLength;
    if (page.length < PAGE) break;
  }
  return { rows, parts: part, bytes_gzip: bytes };
}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Delete daily/ prefixes older than RETENTION_DAYS. The prefixes are dated,
// so "older" is a string comparison on the date part of the key.
async function pruneOld(bucket, today) {
  const cutoff = new Date(Date.parse(today) - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const old = [];
  let cursor;
  do {
    const l = await bucket.list({ prefix: 'daily/', delimiter: '/', cursor });
    for (const p of l.delimitedPrefixes || []) {
      if (p.slice('daily/'.length, 'daily/'.length + 10) < cutoff) old.push(p);
    }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  let objects = 0;
  for (const p of old) {
    let c;
    do {
      const l = await bucket.list({ prefix: p, cursor: c });
      if (l.objects.length) {
        await bucket.delete(l.objects.map(o => o.key));
        objects += l.objects.length;
      }
      c = l.truncated ? l.cursor : undefined;
    } while (c);
  }
  return { days: old.length, objects, older_than: cutoff };
}

async function logRun(db, r) {
  try {
    await db.prepare(RUNS_DDL).run();
    await db.prepare(`INSERT OR REPLACE INTO backup_runs
        (ts, ok, tables, rows, bytes_gzip, duration_ms, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(r.ts, r.ok, r.tables, r.rows, r.bytes, r.duration_ms, r.error).run();
  } catch (e) {
    console.error('d1-backup: could not record the run —', e && e.message);
  }
}

// Optional phone alert on failure. Both secrets unset = silently skipped.
async function pushover(env, what) {
  if (!env.PUSHOVER_TOKEN || !env.PUSHOVER_USER) return;
  try {
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: env.PUSHOVER_TOKEN, user: env.PUSHOVER_USER, priority: 1,
        title: 'BaliAir cloud backup FAILED',
        message: String(what).slice(0, 900),
      }),
    });
  } catch (e) {
    console.error('d1-backup: pushover failed —', e && e.message);
  }
}
