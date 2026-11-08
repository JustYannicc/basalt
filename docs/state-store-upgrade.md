# State Worker code upgrade

The **State store upgrade** Actions workflow upgrades only the existing State
Worker from contract version 7 to 8. The pinned SDK builds its normal Worker
entry and Store class. No Alchemy State initialization or generic bootstrap runs.
The operation reads metadata and the public `/version` endpoint. It never reads
State contents or creates, updates or deletes Secrets Store resources.

## Prepare and apply

Run `state-store-upgrade.yml` on `main` with mode `dry-run`. The default makes
only GET requests. Its receipt and step summary name the Worker, serving
deployment, immutable Worker version, Store namespace, version 7 to 8 change,
every unchanged binding and the candidate code hashes. Binding values remain
private; their hashes commit the plan to the exact observed values.
The plan includes the exact outbound version metadata and its byte checksum.
Script-level observability, placement and limits stay on the existing script.
The provider-managed `workers/triggered_by` annotation is omitted from uploads
and comparisons; writable annotations and every other setting remain checked.

Review that receipt alongside the encrypted prior Worker code and recorded
settings/bindings. Keep the recorded prior Worker version available for rollback.
The local compatibility proof is separate from the production operation. It
uses synthetic data and the recorded v7 bundle, upgrades to the pinned v8
bundle, then reloads v7 against the same SQLite namespace and encryption key.
It checks resource records, replaced records, outputs, output-only stages and
reader grants. Miniflare does **not** prove production PITR.

After explicit approval, dispatch `apply` with the receipt's exact Worker ID,
deployment ID, namespace ID, explicit version `7`, and plan checksum. Any
changed input, code, setting, binding or key identity refuses by name before
upload. The operation shares the production deployment concurrency group.

The operation uploads one immutable code version with strict inherited bindings,
verifies those bindings, immutable runtime limits, the unchanged settings and
the existing 750 ms startup budget before activation, then
activates that version at 100 percent. It makes no DO class migration. It verifies
`/version = 8`, the serving immutable version, namespace and encryption-key
identity afterwards. Version propagation has a fixed 60-second window.

Cloudflare's legacy version-upload API inherits bindings from the **latest
uploaded** version, which can differ from the serving version. This operation
refuses that starting state and rechecks inheritance before activation. See
[inherit binding errors](https://developers.cloudflare.com/workers/observability/errors/#inherit-binding-errors-10057).

## Stop and recover

The receipt records each upload and activation intent before sending it. Neither
write retries. A lost response leaves an uncertain operation, not permission to
run apply again. Keep the receipt and inspect deployment/version metadata first.
A refusal after upload can leave an unserved version; it activates nothing.
An activation failure can still have taken effect. Reconcile the exact IDs in
the receipt before deciding the next operation.
Provider refusals retain bounded, sanitized Cloudflare codes and messages in the
receipt and summary. Credentials, headers and raw response bodies stay out.

If the new code fails, restore the recorded previous Worker version through a
separately approved deployment. Preserve every setting, secret binding and the
same Store namespace. A Worker code rollback restores no database data. Confirm
the recorded prior immutable version serves, `/version = 7`, and namespace/key
identity still match. Do not delete or recreate the Worker, namespace or secrets.

## Data recovery with Durable Objects PITR

Cloudflare's [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
provides a rolling 30-day recovery window for SQLite-backed classes, covering
both SQL and KV data. The production Store namespace metadata records
`use_sqlite: true`; although Store uses the KV API, its encrypted records are
covered. Recovery still needs the original encryption key. Keep it unchanged.

PITR works per object, not atomically across a namespace. It is unavailable in
local development. The State Worker exposes no recovery method today. The
following is a recovery procedure for a separately reviewed handler, not a
handler this workflow deploys or invokes:

1. Suspend State writers and release workflows. Record the incident cutoff UTC
   time, namespace ID, class, secret/key identity and active Worker version.
   Choose a cutoff within the preceding 30 days and before the damaging write.
2. Enumerate **all object IDs** in the exact namespace through the paginated
   [List Objects API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/).
   Do not use State's stack/stage listings for recovery coverage. They can omit
   output-only stages and orphaned stack objects.
3. Prepare a temporary full-access-authenticated recovery route and a private
   Store RPC on the **existing class and namespace**. It must accept an
   allow-listed exact object ID and reviewed cutoff/bookmark, verify the
   namespace/key identities, and refuse ordinary/scoped reader credentials.
   Deploying it requires separate approval. It must add no storage migration.
4. Through `namespace.idFromString(id)` and `namespace.get(id)`, call that object's
   RPC to obtain `ctx.storage.getCurrentBookmark()` and
   `ctx.storage.getBookmarkForTime(cutoff)`. Retain both bookmarks externally in
   a private per-object receipt. Neither bookmark call restores data.
   Stop for an object without an available pre-incident bookmark; do not delete
   it or silently omit it from recovery.
5. For each approved object, call
   `await ctx.storage.onNextSessionRestoreBookmark(targetBookmark)`. Persist
   its returned **undo bookmark** externally before proceeding. This arms
   restoration for that object's next session; it is not a completed restore.
6. Call a separate private restart RPC that invokes `ctx.abort()`. The resulting
   disconnect is expected. On the next request the object restores the armed
   bookmark. Verify the object reopens and the expected records are readable
   through the normal State API. Record completion per object. Keep writers
   suspended until every selected object is verified.
7. If a restore was wrong, use the retained undo bookmark with the same arm,
   restart and verification steps. Remove the recovery handler after verified
   recovery, recheck the unchanged namespace/key identities, then resume writers.

Do not restart an armed restore before retaining its undo bookmark, log State values or
keys, or assume a code rollback undoes an armed data restore. If the cutoff is
outside the retention window or the original key is unavailable, stop and
escalate; this workflow cannot repair either condition.
