"""Read one bounded metadata-only page from the live Manager Plus database.

Run with Python on the source host. The database is opened read-only and every
page closes its transaction before emitting output. No source file is copied.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import time

parser = argparse.ArgumentParser()
parser.add_argument('--database', required=True)
parser.add_argument('--source', required=True)
parser.add_argument('--upper', type=int, required=True)
parser.add_argument('--after', type=int, required=True)
parser.add_argument('--end', type=int)
args = parser.parse_args()
if args.after < 0 or args.upper < args.after or args.end is not None and not args.after <= args.end <= args.upper:
    raise SystemExit('Invalid page bounds')
if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', args.source):
    raise SystemExit('Invalid source lineage')


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def ref(kind, value):
    return None if value is None or value == '' else digest(['cpamp-reference-v1', args.source, kind, str(value)])


def label(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@+\-]{0,255}', value) else None


def count(value):
    if value is None:
        return None
    if not isinstance(value, int) or value < 0 or value > 9223372036854775807:
        raise ValueError('Invalid source counter')
    return str(value)


connection = sqlite3.connect('file:' + args.database + '?mode=ro', uri=True, timeout=.05)
connection.row_factory = sqlite3.Row
started = time.monotonic()
try:
    connection.execute('PRAGMA query_only=ON')
    connection.execute('PRAGMA trusted_schema=OFF')
    deadline = time.monotonic() + .25
    connection.set_progress_handler(lambda: time.monotonic() > deadline, 1000)
    connection.execute('BEGIN')
    # Only selected metadata is read. Payloads and descriptive account fields never enter Python.
    rows = connection.execute('''SELECT id,event_hash,timestamp,provider,model,endpoint,service_tier,
        request_id,auth_index,api_key_hash,input_tokens,output_tokens,cache_read_tokens,
        cache_creation_tokens,reasoning_tokens,total_tokens,latency_ms,failed,fail_status_code,generate
        FROM usage_events WHERE id>? AND id<=? ORDER BY id LIMIT 201''',
        (args.after, args.end if args.end is not None else args.upper)).fetchall()
    if args.end is not None and len(rows) > 200:
        raise ValueError('Range is larger than one page')
    selected = rows[:200]
    connection.rollback()
finally:
    connection.close()
read_ms = round((time.monotonic() - started) * 1000, 3)
records = []
non_generation = 0
for row in selected:
    if row['failed'] not in (0, 1) or not re.fullmatch(r'[a-f0-9]{64}', row['event_hash'] or ''):
        raise ValueError('Invalid source event identity')
    non_generation += row['generate'] == 0
    status = row['fail_status_code'] if row['failed'] and row['fail_status_code'] else None
    endpoint = row['endpoint']
    if endpoint not in ['/v1/chat/completions', '/v1/responses', '/v1/responses/compact', '/v1/messages',
                        '/v1/embeddings', '/v1/completions', '/v1/images/generations', '/v1/images/edits',
                        '/v1/audio/transcriptions'] and not re.fullmatch(
                            r'/v1beta/models/[A-Za-z0-9._-]+:(?:streamGenerateContent|generateContent)', endpoint or ''):
        endpoint = None
    records.append({
        'source_id': str(row['id']), 'event_hash': row['event_hash'], 'timestamp': row['timestamp'],
        'provider': label(row['provider']), 'model': label(row['model']), 'endpoint': endpoint,
        'service_tier': label(row['service_tier']), 'request_id': ref('request', row['request_id']),
        'account_ref': ref('account', row['auth_index']), 'client_key_ref': ref('key', row['api_key_hash']),
        'input_tokens': count(row['input_tokens']), 'output_tokens': count(row['output_tokens']),
        'cache_read_tokens': count(row['cache_read_tokens']), 'cache_write_tokens': count(row['cache_creation_tokens']),
        'reasoning_tokens': count(row['reasoning_tokens']), 'total_tokens': count(row['total_tokens']),
        'latency_ms': count(row['latency_ms']), 'failed': bool(row['failed']), 'status_code': status,
        'generate': None if row['generate'] is None else bool(row['generate']),
    })
end = int(selected[-1]['id']) if selected else args.after
if args.end is not None and end != args.end:
    raise ValueError('Page range changed')
print(json.dumps({'after': str(args.after), 'end': str(end), 'upper': str(args.upper),
                  'more': len(rows) > 200, 'checksum': digest(records), 'rows': records,
                  'nonGeneration': non_generation, 'readMs': read_ms}, separators=(',', ':')))
