# d1-backup — daily copy of the archive into R2

Once a day this worker reads every table of the `bali-air-archive` D1
database through its binding and writes it to the private `baliair-backups`
bucket as gzipped JSONL, one object per 5,000 rows:

```
latest.json                              the newest manifest, for a quick check
daily/2026-09-12/manifest.json           what was copied, with counts and timing
daily/2026-09-12/station_snapshots/part-00000.jsonl.gz
daily/2026-09-12/station_snapshots/part-00001.jsonl.gz
…
daily/2026-09-12/stations/part-00000.jsonl.gz
```

Each object's metadata carries the table name, its row count and the SHA-256
of the uncompressed lines. Days older than 90 are deleted by the worker after
each successful run. Every run, successful or not, writes one row to
`backup_runs` in the database (`schema-v11-backup-runs.sql`); the operator's
hourly heartbeat reads that table and pages when more than 26 hours pass
without a successful run.

It runs entirely inside Cloudflare, with bindings only — no API token, no
laptop. It is one of three layers, each covering what the others cannot:

| Layer | Covers | Does not cover |
|---|---|---|
| D1 Time Travel (built in, 30 days) | restoring the whole database to any minute in the last 30 days | anything older; loss of the database or account itself |
| This worker (R2, 90 days) | any day in the last 90, row by row, independent of any machine | loss of the whole Cloudflare account |
| Nightly dump on the operator's Mac (14 days + monthly) | a copy held outside Cloudflare | a machine that is switched off at 07:41 (it catches up hourly once it is on) |

## Checking it

```bash
wrangler r2 object get baliair-backups/latest.json --pipe
wrangler d1 execute bali-air-archive --remote --command "SELECT datetime(ts,'unixepoch') AS started, ok, tables, rows, bytes_gzip, duration_ms, error FROM backup_runs ORDER BY ts DESC LIMIT 7"
```

## Running it by hand

The worker has no public URL. To trigger a run outside the cron, run it
locally against the real bindings and hit the scheduled endpoint:

```bash
cd workers/d1-backup
wrangler dev --remote --test-scheduled
# in another shell:
curl "http://localhost:8787/__scheduled?cron=23+19+*+*+*"
```

## Restoring

1. Stand up an empty database with the schema (`D1-SETUP.md` §1–2, all
   `schema-v*.sql` files in order).
2. Download a day. Wrangler fetches one object at a time, so use the manifest
   to drive it:

   ```bash
   DAY=2026-09-12
   mkdir -p restore/$DAY && cd restore/$DAY
   wrangler r2 object get baliair-backups/daily/$DAY/manifest.json --pipe > manifest.json
   python3 - <<'PY'
   import json, subprocess
   m = json.load(open('manifest.json'))
   for table, info in m['tables'].items():
       for i in range(info['parts']):
           key = f"daily/{m['day']}/{table}/part-{i:05d}.jsonl.gz"
           subprocess.run(['wrangler', 'r2', 'object', 'get', f'baliair-backups/{key}', '--file', key.replace('/', '__')], check=True)
   PY
   ```

3. Turn the day into SQL and load it:

   ```bash
   python3 ../../workers/d1-backup/scripts/restore-jsonl-to-sql.py . > restore.sql
   wrangler d1 execute bali-air-archive --remote --file restore.sql
   ```

   The script emits `INSERT OR IGNORE`, so loading a day into a database that
   already holds some of its rows is safe and idempotent.
