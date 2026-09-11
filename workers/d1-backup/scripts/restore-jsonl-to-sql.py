#!/usr/bin/env python3
"""Turn one downloaded day of d1-backup objects into SQL.

    python3 restore-jsonl-to-sql.py <dir with manifest.json and the part files> > restore.sql

Part files may be laid out as daily/<day>/<table>/part-NNNNN.jsonl.gz or with
the slashes replaced by '__' (as the README's download loop names them). Emits
INSERT OR IGNORE statements, 500 rows each, so loading into a database that
already holds some of the rows is safe. The schema must already exist.
"""
import glob
import gzip
import json
import os
import sys

def sql_value(v):
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return '1' if v else '0'
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"

def main(root):
    manifest = json.load(open(os.path.join(root, 'manifest.json')))
    day = manifest['day']
    total = 0
    for table, info in manifest['tables'].items():
        files = []
        for i in range(info['parts']):
            key = f'daily/{day}/{table}/part-{i:05d}.jsonl.gz'
            for cand in (os.path.join(root, key), os.path.join(root, key.replace('/', '__'))):
                if os.path.exists(cand):
                    files.append(cand)
                    break
            else:
                sys.exit(f'missing part: {key}')
        rows = 0
        batch = []
        cols = None
        def flush():
            if batch:
                print(f'INSERT OR IGNORE INTO "{table}" ({", ".join(chr(34) + c + chr(34) for c in cols)}) VALUES')
                print(',\n'.join('  (' + ', '.join(sql_value(r.get(c)) for c in cols) + ')' for r in batch) + ';')
                batch.clear()
        for f in files:
            with gzip.open(f, 'rt', encoding='utf-8') as h:
                for line in h:
                    r = json.loads(line)
                    if cols is None:
                        cols = list(r.keys())
                    batch.append(r)
                    rows += 1
                    if len(batch) >= 500:
                        flush()
        flush()
        if rows != info['rows']:
            sys.exit(f'{table}: manifest says {info["rows"]} rows, files hold {rows}')
        print(f'-- {table}: {rows} rows')
        total += rows
    print(f'-- total: {total} rows from {day}')

if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
