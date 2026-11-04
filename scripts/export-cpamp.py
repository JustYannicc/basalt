"""Export bounded read-only Manager Plus pages, then recheck every page range.

The metadata pages and receipt are private local files. Resume trusts only pages
whose bytes still match their receipt. No database or other file is copied from
the host. The explicit frozen watermark is reused on every invocation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--host', required=True)
parser.add_argument('--database', required=True)
parser.add_argument('--source', required=True)
parser.add_argument('--upper', type=int, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--max-rows', type=int, default=50000)
parser.add_argument('--interval', type=float, default=1)
parser.add_argument('--verify-only', action='store_true')
parser.add_argument('--min-free-gib', type=int, choices=[22, 25], default=25)
args = parser.parse_args()
if args.max_rows <= 0 or args.max_rows % 200 or args.interval < 1 or args.upper < 0:
    raise SystemExit('Invalid bounded export parameters')
if args.min_free_gib == 22 and args.max_rows > 50000:
    raise SystemExit('The lower disk floor applies only to the bounded sample')
args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
script = Path(__file__).with_name('cpamp-read-page.py').read_bytes()
receipt = args.output / 'pages.jsonl'
header = {'version': 1, 'host': args.host, 'database': args.database,
          'source': args.source, 'upper': str(args.upper), 'maxRows': args.max_rows}


def private_write(path, data):
    with open(path, 'xb') as target:
        os.chmod(path, 0o600)
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def page_read(after, end=None):
    # The only remote command reads the explicitly selected database. No shell interpolation.
    import shlex
    command = ['sudo', 'python3', '-', '--database', args.database, '--source', args.source,
               '--upper', str(args.upper), '--after', str(after)]
    if end is not None:
        command += ['--end', str(end)]
    started = time.monotonic()
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.host,
                             shlex.join(command)], input=script, capture_output=True, timeout=15)
    if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
        raise RuntimeError('Source page refused; no automatic retry')
    page = json.loads(result.stdout)
    if page['upper'] != str(args.upper) or page['after'] != str(after) or len(page['rows']) > 200:
        raise RuntimeError('Invalid source page')
    time.sleep(max(0, args.interval - (time.monotonic() - started)))
    return page


if not receipt.exists():
    if args.verify_only:
        raise SystemExit('No export checkpoint to verify')
    private_write(receipt, canonical(header) + b'\n')
entries = []
with open(receipt) as source:
    if json.loads(next(source)) != header:
        raise SystemExit('Resume parameters changed')
    for line in source:
        entry = json.loads(line)
        if 'page' not in entry:
            raise SystemExit('Invalid checkpoint')
        entries.append(entry)
after, total = 0, 0
for number, entry in enumerate(entries):
    if entry['page'] != number or entry['after'] != str(after):
        raise SystemExit('Noncontiguous checkpoint')
    data = (args.output / f'{number:06d}.jsonl').read_bytes()
    if hashlib.sha256(data).hexdigest() != entry['fileHash']:
        raise SystemExit('Checkpoint file changed')
    after, total = int(entry['end']), total + entry['count']

with open(receipt, 'ab', buffering=0) as log:
    while not args.verify_only and after < args.upper and total < args.max_rows:
        # Stop before allocating the next page if this would break the coordinator's floor.
        if shutil.disk_usage(args.output).free < args.min_free_gib * 1024 ** 3 + 8 * 1024 ** 2:
            raise SystemExit('Export stopped at disk floor')
        page = page_read(after)
        if not page['rows']:
            break
        if int(page['end']) <= after:
            raise RuntimeError('Source cursor did not advance')
        number = len(entries)
        data = b'\n'.join(canonical(row) for row in page['rows']) + b'\n'
        file = args.output / f'{number:06d}.jsonl'
        # An interrupted unacknowledged page is reconciled, never silently replaced.
        if file.exists():
            if file.read_bytes() != data:
                raise RuntimeError('Unacknowledged page changed')
        else:
            private_write(file, data)
        entry = {'page': number, 'after': str(after), 'end': page['end'], 'count': len(page['rows']),
                 'checksum': page['checksum'], 'fileHash': hashlib.sha256(data).hexdigest(),
                 'nonGeneration': page['nonGeneration'], 'readMs': page['readMs']}
        log.write(canonical(entry) + b'\n')
        os.fsync(log.fileno())
        entries.append(entry)
        after, total = int(page['end']), total + len(page['rows'])
        if number % 25 == 0:
            print(json.dumps({'pages': len(entries), 'rows': total}), flush=True)
        if not page['more']:
            break

# Separate second pass detects any changed/deleted row in every exported range.
for entry in entries:
    page = page_read(int(entry['after']), int(entry['end']))
    if page['checksum'] != entry['checksum'] or len(page['rows']) != entry['count']:
        raise RuntimeError('Append-only source assumption failed; stop import')
summary = {'verifiedTwice': True, 'rows': total, 'pages': len(entries), 'upper': str(args.upper),
           'through': str(after), 'complete': after == args.upper,
           'nonGeneration': sum(entry['nonGeneration'] for entry in entries),
           'manifestHash': hashlib.sha256(receipt.read_bytes()).hexdigest()}
print(json.dumps(summary), flush=True)
