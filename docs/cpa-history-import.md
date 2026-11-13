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
`--caller`, `--source`, `--file` and `--report` for its dry run. Use
`--owner-session-file` with `--organization` and `--pool` to authenticate as the
recorded pool owner. The private file contains the Cookie header from that
owner's normal signed-in session, with no newline. It must be a regular file
readable only by its owner. Never print it or put it in a command argument.
The CLI checks `/api/viewer` against `--caller` before sending a page; the host
checks current owner and app-management permission on every dry run and apply.
An organization administrator or app manager who is not that pool owner cannot
import. No model API key or new import credential is created.

Existing internal operators may still supply `--pool-token-file` instead of the
session arguments. Both transports use the same source namespace, mapped records
and exact-ID manifest. The owner route is
`POST /api/organizations/:organization/apps/:app/pool-usage/import`, with
`mode` set to `dry-run` or `apply`. It preserves account attribution; the
self-service import route has its own attribution and source rules.

A multi-page JSONL file is streamed with at most 200 rows per HTTP request.
The complete report binds the source file digest, caller, destination and exact
request IDs. A temporary disk-backed index rejects repeated IDs across the whole
export and approved manifest before any apply request. It contains no bearer credential or reusable page approval.

To attribute known source accounts to current pool accounts, pass a private
`--account-map-file` containing an array of
`{ "sourceAccountRef": "<64-character exported hash>", "targetAccountId": "<Home credential ID>", "provider": "<provider ID>" }`.
Verify those identities from metadata before approval. The server requires each
target to be enabled, selected in the destination pool and of the same provider.
Unlisted source accounts keep their foreign references. The complete map and its
file digest are bound into the dry-run manifest and each page approval. Use the
same file for apply and replay. An event's attribution cannot change after import.
The CLI requires the server to acknowledge the canonical map digest before apply,
so an older server cannot silently ignore the map.

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
or app. Foreign account hashes identify current native accounts only through the
explicit operator map. Mapped history contributes to the current account's
request series and last-success under the existing saved-account permissions.
It does not supply quota observations or backfill forecast training. No
provider invoice or canonical token-breakdown proof exists in this source, so
these rows remain unpriced with legacy token quality. After apply, reconcile
counts and token sums by day and model against the verified source ranges, and
verify the history on the selected team's live interface.


After exact reconciliation, use the private completion operator to record the
accepted source range. Its selection names the pool, source UUID, canonical
`frozenFrom` and `frozenTo`, `afterSourceId` and `upperSourceId`, accepted manifest
and account-map digests, exact ID-set digest, and cumulative `verifiedRows`.
The first completion starts after source ID `0`; a top-up names the preceding
checkpoint's upper ID and cannot shrink its range or rewind its source watermark.
The ID-set digest hashes sorted IDs within each two-character hexadecimal prefix,
then hashes the sorted `prefix:hash` lines. Both levels join with a newline and
omit a trailing newline. The operator checks the accepted manifest against that
same digest before contacting the database. It also checks source-file and page
hashes, resolved IDs, timestamps and the actual upper source ID. For a top-up,
repeat the `--file` and `--manifest` pair for every accepted segment in source
order, including the preceding completed range. The new checkpoint records the
latest accepted segment manifest and the cumulative verified ID set.

Run `node scripts/pool-import-completion.ts --worker <script> --account-id
<account> --selection <private-selection.json> --file <frozen-metadata> --manifest <accepted-manifest>
--plan <new-private-plan.json>` for a read-only plan. After reviewing its exact
reconciliation and preceding checkpoint, repeat with `--apply --go`. The private
operations binding supplies authority; the public Worker cannot finalize history.
A started receipt prevents repeating an uncertain dispatch. Inspect the saved
plan and receipt, then read a fresh plan instead of retrying a lost response.

Completion records only the explicitly verified frozen range. The pool series
API reports an incomplete import as `backfillComplete: false` and includes its
completion range and source watermark after finalization. Consumers must use that
range rather than treating it as proof of later or earlier history. Home capture
keeps its separate cursor. Schema v8 adds one small table without a backfill or
an index on request history.
