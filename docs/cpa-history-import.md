# Import retained Manager Plus usage

Manager Plus keeps individual requests in SQLite. This path brings their selected
metadata into Basalt's existing append-only request ledger without copying the
live database or reading prompts, response bodies, IPs or account labels.

The source must retain stable rows below a frozen upper ID. Freeze the maximum
`usage_events.id` in a short read-only transaction and retain one source UUID for
that database lineage. Reuse both when resuming. Never make a new source UUID to
work around a rejected duplicate: that would count the same requests twice.

## Export and verify

Run `scripts/export-cpamp.py` with `--host`, `--database`, `--source`, `--upper`
and a private `--output` directory. The remote host needs Python and read access
through the existing operator's `sudo` authorization. The script sends only the
reader program; it creates no remote file. It reads no other source files.

The default is a 50,000-row sample, 200 rows per transaction, at least one second
between reads. A 250 ms SQL deadline and 50 ms lock timeout stop an overloaded
source rather than waiting. Transactions close before the program transforms or
transfers the metadata. Source account, key and request references are hashed
before leaving the host. Successful requests with no recorded HTTP status remain
unknown. Token counts retain their original meaning as legacy accounting.

The exporter stores private page files and a fsynced `pages.jsonl` checkpoint.
After exporting, it reads every page range again and compares its checksum. A
change refuses verification. `--verify-only` repeats that check without allocating
another page. Checksum verification does not make a mutable source immutable;
recheck the ranges before applying, and stop if the append-only assumption fails.

The exporter stops new page allocations before local free space falls below
25 GiB plus one maximum page. An explicitly authorized sample of at most 50,000
rows may use `--min-free-gib 22`; larger exports reject that lower floor.
Do not bypass the selected floor. Existing checkpoints stay
available for a later resume with the same arguments. No source row is changed.

## Review and import

Measure destination storage on the bounded sample before importing the full set.
Keep heap, index and WAL measurements distinct and state the test engine. A local
PostgreSQL-compatible sample does not establish managed Postgres WAL growth or
Worker latency. Record the source watermark, range checksums, exact destination
IDs, non-generation count, token quality, missing fields and unpriced coverage.
Requests include failed and zero-token events; request counts do not imply model
generations. The current ledger stores neither a requested/resolved-model pair
nor the source generation flag, so retain that distinction in the source receipt.

For each metadata page, `node scripts/import-cpamp.ts` takes `--target`,
`--pool-token-file`, `--caller`, `--source`, `--file` and `--report` for its dry
run. A multi-page JSONL file is streamed with at most 200 rows per HTTP request.
The complete report binds the source file digest, caller, destination and exact
request IDs. A temporary disk-backed index rejects repeated IDs across the whole
export and approved manifest before any apply request. It contains no bearer credential or reusable page approval.

Production needs the selected organization and pool inventory, backup receipts,
a complete exact-ID dry run and the coordinator's GO for its report digest.
The source exporter and importer never grant that GO themselves.

Apply with the same source arguments plus `--apply-report`, `--approve` with the
approved report's SHA-256 and a new private `--receipts` path. Every page gets a
fresh short-lived server approval; the full report remains the reviewed boundary.
Acknowledgements are fsynced. A lost response stops the process without retrying.
Reconcile the IDs, then restart with the same approved source and a new receipts
path: retained identical rows insert zero, and changed content fails. Replaying
pages does not change previous attribution or spend caps.

Imported history is attributed to the import operation, not to an original person
or app. Foreign account hashes do not identify current native accounts. No
provider invoice or canonical token-breakdown proof exists in this source, so
these rows remain unpriced with legacy token quality. After apply, reconcile
counts and token sums by day and model against the verified source ranges, and
verify the history on the selected team's live interface.
