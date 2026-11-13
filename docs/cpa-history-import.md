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

## Bulk import from an accepted manifest

For a large verified export, `scripts/import-cpamp-bulk.ts` reuses the original
metadata, exact-ID manifest, source UUID and account map. Run its `prepare`
command with those files, the accepted manifest's SHA-256, the same destination
and owner, and a new private `--descriptor` path. `--help` lists the exact
arguments. Preparation checks every original 200-row page hash and ID before
writing a small descriptor. It neither contacts the source nor copies the export.
Keep the accepted files unchanged for upload, apply and recovery.

Run `upload` with the descriptor, private owner session and a new `--receipts`
path. It rechecks the inputs and stages immutable chunks in EU object storage,
with at most 5,000 rows and 8 MiB per chunk. Upload does not approve or insert
history. Review the descriptor's `manifestDigest` and canonical
`accountMappingDigest` acknowledgement. Production apply still needs the
coordinator's GO for that exact descriptor digest; approval of the original
manifest alone does not start the bulk job.

Run `apply` with the same descriptor and owner session, a new receipts path,
`--approve` set to the exact `manifestDigest`, and `--guard-file` pointing to
fresh observations from the external guardian. The guard JSON requires
`observedAt`, `expiresAt` and `cpuAt` in Unix milliseconds, `ready`, `cpu`,
`releaseReadComplete`, `releaseWindowActive`, `poolErrors` and `queryErrors`. Observations expire within ninety seconds. Never refresh
the timestamps yourself or replace missing error counts with zero. The guardian
continues to enforce its CPU/error pause and recovery policy. Missing, stale or
unsafe observations pause the job, including when the operator client stops.

The EU job starts SQL batches at 500 rows and adjusts toward 500 milliseconds of
database work, bounded between 100 and 5,000 rows. A persisted cooldown separates
batches. CPU at least 70 percent pauses work until below 60 percent. Two minutes
at least 90 percent or any database error stops the job for operator attention.
Release and backup windows pause work. Status retains batch size, observed rate
and the throttle reason; a stopped job requires explicit owner resume.

Serving telemetry is optional until a verified source is configured. Status says
not available when none exists. A configured source is binding, with a frozen
pre-import, non-release five-minute baseline per route and stream mode. P99 needs
at least 20 successful completions, with 100 preferred. Thresholds are the greater
of 1.25 times baseline p99 and baseline p99 plus 100 milliseconds, or baseline
failure rate plus one percentage point. Two regressed fresh checks at least sixty
seconds apart pause work. Any new 5xx against a zero-5xx baseline pauses immediately.
Failed retrieval or observations/computations older than 120 seconds also pause.
These tolerances are engineering policy, not measured safe constants. Model
completion timing and separately labeled serving-dependency timing stay distinct;
control/session durations never substitute for model completions. No probe traffic
is needed or generated. Counts, windows, thresholds and unavailable state persist.

The EU job processes one bounded SQL batch per alarm. Every new chunk rechecks the
current owner's authority and the mapped targets' enabled, selected,
same-provider state. Its transaction saves the exact artifact subrange receipt with the request
rows. Replaying an identical subrange returns that receipt's original counts;
changed input or retained contents refuses. Existing imported rows and live
capture keep the same event identities, so overlap does not add duplicate usage.

Use `status` or `watch` to inspect progress, `pause` to stop new chunks, and
`resume` with the same descriptor, approval digest and a fresh guard after
recovery. A chunk already admitted may finish. A lost HTTP response stops the
client without automatic mutation retry. Inspect the private receipts, request
`status` with a new receipts path, and reconcile before explicitly resuming.
An interrupted upload can be rerun explicitly with the same immutable descriptor.
After completion, reconcile retained counts and token sums against the accepted
source ranges and verify the selected team's history. Local timing does not
establish production throughput.

Imported history is attributed to the import operation, not to an original person
or app. Foreign account hashes identify current native accounts only through the
explicit operator map. Mapped history contributes to the current account's
request series and last-success under the existing saved-account permissions.
It does not supply quota observations or backfill forecast training. No
provider invoice or canonical token-breakdown proof exists in this source, so
these rows remain unpriced with legacy token quality. After apply, reconcile
counts and token sums by day and model against the verified source ranges, and
verify the history on the selected team's live interface.
