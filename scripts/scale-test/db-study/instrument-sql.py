"""Patch only the diagnostic GOROOT; reject source drift instead of guessing."""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
helper = pathlib.Path(sys.argv[2])
source = root / 'src/database/sql/sql.go'
before = source.read_text()
text = before
for name, capital in [('conn', 'Conn'), ('putConn', 'PutConn'), ('execDC', 'ExecDC'), ('queryDC', 'QueryDC'), ('beginDC', 'BeginDC')]:
    needle = 'func (db *DB) ' + name + '('
    if text.count(needle) != 1:
        raise ValueError('Diagnostic SQL function drift: ' + name)
    text = text.replace(needle, 'func (db *DB) basaltOriginal' + capital + '(', 1)
replacements = [
    ('\t\tres, err = resultFromStatement(ctx, dc.ci, ds, args...)',
     '\t\tid, began := basaltFixtureQuery(dc, "prepared-exec", s.query, len(args))\n\t\tres, err = resultFromStatement(ctx, dc.ci, ds, args...)\n\t\tbasaltFixtureQueryEnd(id, began, err)'),
    ('\t\trowsi, err = rowsiFromStatement(ctx, dc.ci, ds, args...)',
     '\t\tid, began := basaltFixtureQuery(dc, "prepared-query", s.query, len(args))\n\t\trowsi, err = rowsiFromStatement(ctx, dc.ci, ds, args...)\n\t\tbasaltFixtureQueryEnd(id, began, err)'),
    ('\t\terr = tx.txi.Commit()', '\t\tid, began := basaltFixtureQuery(tx.dc, "commit", "COMMIT", 0)\n\t\terr = tx.txi.Commit()\n\t\tbasaltFixtureQueryEnd(id, began, err)'),
    ('\t\terr = tx.txi.Rollback()', '\t\tid, began := basaltFixtureQuery(tx.dc, "rollback", "ROLLBACK", 0)\n\t\terr = tx.txi.Rollback()\n\t\tbasaltFixtureQueryEnd(id, began, err)'),
]
for needle, replacement in replacements:
    if text.count(needle) != 1:
        raise ValueError('Diagnostic statement hook drift: ' + needle.strip())
    text = text.replace(needle, replacement, 1)
source.write_text(text)
(root / 'src/database/sql/basalt_fixture_trace.go').write_bytes(helper.read_bytes())
print(json.dumps({'originalSqlSHA256':hashlib.sha256(before.encode()).hexdigest(),'instrumentedSqlSHA256':hashlib.sha256(text.encode()).hexdigest(),'helperSHA256':hashlib.sha256(helper.read_bytes()).hexdigest(),'scope':'diagnostic toolchain only; release image remains unchanged'}))
