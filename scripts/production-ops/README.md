# Production operations

Use this workflow when a repair needs the deployed application's database access.
It runs a reviewed, named operation through the Cloud runtime using the existing
deploy signing and encryption keys. Actions never receives a database URL.
There is no SQL input.

`Production operations` runs only by manual dispatch on `main`, under the existing
`production-release` environment. Dispatches run one at a time. Inventory, backup
and dry-run inspection use a read-only repeatable-read transaction. Only a
registered migration can write, in a serializable transaction.

## Read an inventory

Create a recipient locally. The command prints a public key; the private key stays
in the specified file with mode `0600`.

```sh
node scripts/production-ops/artifact.ts recipient /private/path/ops-recipient.pem
```

Dispatch `production-ops.yml` on `main` with `action=inventory`, the public key as
`recipient`, `request={"organization":"<organization-id>"}`, and one selection:

- `organizations`: the selected organization's member IDs, email, roles, linked
  sign-in providers and email verification.
- `accounts`, `pools`, `app-links`, `retired-tokens`, `departures`, `workflows`,
  `schedules`, `reporters` or `receipts`.
- `connections`: the organization's account connections as metadata only: ID,
  provider, target app and requirement, stored status, whether it has expired,
  whether it produced an account (new, reconnected or reused), and its created
  and expiry times. Never the rest of its state, its sign-in attempt or account.
  A pending connection past its expiry reads `pending` with `expired: true`.
- `connections-summary`: the same connections counted by status, expiry, target
  app and provider, with the first and last creation times. Use it when the
  organization may have more connections than the row bound.
- `tool-call-traffic`: each of the organization's accounts with every hour of
  tool calls still stored for it: hours with a count, requests, failures, and
  the latest counted hour and success. Hours past retention that no later call
  pruned are included. Counts only, never a call's input or result. A missing
  counts table fails the run with SQL state class `42`.

`retired-tokens` uses the same recorded pool-app, personal placement and exact
provider provenance as host-managed pool-access rows. Labels do not identify
these accounts. Before a retirement GO, compare every dry-run account ID with
the corresponding visible Accounts row.

The workflow's artifact `production-ops-<run ID>` contains `operation.json` and a
safe `summary.json`. Inventories and backups are encrypted before leaving the
runtime; do not paste their decrypted contents into public logs or issues.

A failed run still uploads `failure.json`. Its fixed category and phase locate
the failed boundary; a SQL failure can include its two-character SQL state class.
Known provider-adoption refusals, defects and interruptions have distinct categories.
The cause kind records whether a failure, defect or composite cause reached the boundary.
Use this receipt when deciding the next diagnostic step. It contains no raw error
message, response, SQL statement or credentials, and does not authorize a retry.

Download the artifact, then decrypt its inventory into a private local file:

```sh
node scripts/production-ops/artifact.ts decrypt /private/path/operation.json /private/path/ops-recipient.pem https://app.signalbox.run /private/path/inventory.json
```

A selection exceeding its row or byte bound fails; it never claims to be a
complete truncated inventory. An absent table or unknown selection also fails.
Executor database operations require an existing organization ID in their signed request.
There is no global inventory or discovery fallback.

## Remove reviewed Home imports

`home-agent-import-removal-v1` runs in the pool Worker against Home, separately
from the Executor database migrations below. Its request names `organization`,
`pool`, exactly four `remove` entries with `id` and `provider`, and one `retain`
entry with `id` and `provider`. IDs must be distinct UUIDs. Every membership
referencing a removed credential must belong to that pool, or the operation
refuses. It never selects credentials by name or provider alone.

Run `action=backup` first. The encrypted artifact contains exactly those four
complete Home credential rows and their referencing membership rows. Full rows
remain JSON text so bigint and decimal values survive recovery. The retained
credential contributes only an in-database checksum, never its credential data.
Keep the uploaded artifact and recipient key before proceeding.

Then run `action=migrate`, `mode=dry-run`. This saves another encrypted backup
and an encrypted plan with the exact IDs, membership IDs and row checksums.
Apply uses the successful dry-run dispatch and exact GO described below. It
refuses changed rows, a different database or deployed source, and expired plans.
Home's supported credential DELETE writes its versioned tombstone and reloads
the runtime. The operator then removes the reviewed memberships and verifies
their absence and the retained credential's unchanged checksum. Model serving
is verified separately through the normal pool endpoint.

The pool persists a started receipt before the first DELETE. A failed or uncertain
apply is never retried automatically. Use `action=inventory` with the original
request and `plan_sha256` to inspect its encrypted receipt and current row state.
A completed replay verifies without repeating DELETEs. An incomplete receipt
blocks fresh normal applies, including plans with unchanged rows. Restoring the
encrypted rows needs its own reviewed operation and GO.

For removal recovery, use `selection=home-agent-import-recovery-v1`,
`action=prepare`, the original exact request, `source_run` set to the original
successful dry run, and `plan_sha256` set to that original plan's hash. Preparation
is read-only. It verifies the original plan, backup checksum and incomplete receipt,
then returns a fresh encrypted backup and expiring recovery plan. Review the exact
row hashes, retained checksum and any already-deleted rows before obtaining GO.
Token refreshes can change a credential row; they require review of its fresh hash.

Apply that recovery with the same recovery selection and request,
`action=migrate`, `mode=apply`, `source_run` set to the successful preparation run,
and the new recovery plan's exact hash and GO. Readiness finishes before each
DELETE's 10-second deadline starts. The runtime rechecks the approved snapshot
after readiness, before sending a DELETE.

Recovery preserves the original receipt and writes separate linked progress.
Already-verified tombstones are skipped. A failed recovery is not retried with
the same GO: prepare again from the original successful dry run, review the fresh
plan bound to the latest recovery receipt, and obtain a new GO. This reconciles
committed deletions whose acknowledgements were lost. Inventory of the original
plan exposes the latest recovery plan hash; inventory of that hash exposes its
progress. Successful replay verifies completion without repeating deletions.

Removal failures retain the actual phase, fixed error code, elapsed milliseconds
and selected row ID. A Home HTTP failure also retains its status and an allowlisted
Home error code. Readiness and DELETE timeouts are distinct from precondition
refusals. Raw response bodies, exception text and tokens stay out of these receipts.

## Prepare a repair

A migration lives in the static `production-ops/migrations.ts` registry. Its
module declares affected tables and implements inspect, apply and verify. It
receives the existing SQL service, with no provider HTTP calls during apply.
Network identity proofs belong to a separate registered `prepare` operation.
They must retain the exact account generation and saved-grant fingerprint.

Use `action=prepare` with its registered selection when a migration requires such
proofs. Decrypt that output privately and include the prepared, non-secret proof
in the migration request. Tokens and credential references never belong in
workflow inputs.

Use `action=prepare`, `selection=google-client-diagnostics` with
`request={"organization":"<organization-id>","accounts":["<exact-account-id>"]}`
to distinguish operator-client availability from saved Google client provenance.
The encrypted result contains `configuredClientAvailable` and an account-ID map
of booleans: `savedClientPresent` means the saved authorization client ID exists,
`firstPartyRegistrationMatches` means the saved registration names `google`, and
`clientIdMatches` compares the saved ID with the configured Google client's ID.
The flags are independent; no ID value, secret or token is returned. The operation
accepts 1–50 distinct exact accounts in that organization and uses a SQL read-only
transaction. It makes no provider request, refresh or account change. These flags
do not establish grant health or authorize a reconnect.

For a standalone encrypted snapshot use `action=backup` and select `accounts`,
`pools`, `departures`, `reporters`, `workflows` or a registered migration name.
Snapshots retain the complete affected tables as an encrypted restore superset;
inventory and migration row access stay within the selected organization.

For a repair use `action=migrate`, `mode=dry-run`, the registered migration name,
its exact non-secret JSON request, and your public recipient key. The response
contains an encrypted affected-table backup and an encrypted plan. The plan binds
the target, database, deployed source commit, module revision, exact request,
row keys and before/after hashes, plus the encrypted backup checksum.
The organization is part of the signed request and plan hash. The runner checks
declared row ownership before apply and before verification, including replay.
Row keys must match the table's stable identity exactly. App-link identities include
the nullable subject. Foreign credential, app, account and subject references are
refused. Writes that move a row outside the organization roll back. Global auth and
provider rows may be backed up but cannot be changed by an organization repair.

The successful workflow upload must finish before apply. Download and decrypt
`operation.json` to review the plan and exact IDs. To decrypt the backup, copy its
`backup` object into a private JSON file and use the same decrypt command. Keep
that snapshot and recipient key available for recovery. A snapshot alone is not
a verified restore. Restoring data needs its own reviewed operation and GO.

## Retire redundant Google bindings

Use `google-duplicate-bindings-v1` with
`{"organization":"<organization-id>","pairs":[{"remove":"<legacy-account-id>","retain":"<verified-account-id>","identity":"<verified-identity-id>"}]}`.
Select at most 20 disjoint pairs. The verified replacement must already cover
every app selection with the same provider, method, host policy and placement.
The operation refuses active workflow or webhook consumers, acquisitions,
pending connections and shared legacy grants. Webhook registration also locks and
rereads newly referenced accounts before recording secondary dependencies, so a
concurrent retirement cannot leave an orphaned selection. Labels never establish identity.

Review every deletion in the signed dry run and retain its complete affected-table
backup. The ordinary `accounts` backup does not cover all retired check and source
history. Deployment only registers the operation. Apply still needs GO for the
exact plan. Retirement deletes the selected redundant bindings and their own
grants locally, preserves verified replacements, and never revokes Google consent.

## Remove abandoned account connections

Use `account-connection-retention-v1` with
`{"organization":"<organization-id>","expiredBefore":"<UTC timestamp, e.g. 2026-11-05T00:00:00Z>"}`.
It selects that organization's connections that never produced an account and
expired before the cutoff: the `connections` inventory rows with
`produced_account: false`. The cutoff must be at least 24 hours old, so a
connection that can still complete is never selected, and the reviewed set stays
fixed while time passes. A plan holds at most 200 connections; for a larger
backlog, choose an earlier cutoff first, then repeat with later ones.

Back up with `action=backup` and the migration name first. Like every migration
backup, including the one the dry run saves, it is the runner's whole-table
snapshot of the connection, sign-in attempt and connection access tables, across
all organizations, bounded at 10,000 rows per table and 8 MB. A large backlog can
therefore refuse at the dry run; check the row counts with the
`connections-summary` inventory first. The dry run lists each selected
connection and its access row by exact ID and row checksum. A shared sign-in
attempt is listed once, on its last selected connection. The other selected
connections sharing it show `attempt: null`; this means the attempt is listed
on that last connection, not that they have no attempt. An attempt also named by
a connection outside the selection refuses.
Apply, with GO for that exact plan, removes the listed attempt, then the access
row, then the connection. Each shared attempt is deleted once, with its last
selected connection. Apply refuses if any reviewed row changed or the selection
differs.
Completed connections and every account stay.

The same rule can run daily on its own. Setting the server's
`EXECUTOR_ACCOUNT_CONNECTION_RETENTION` to `true` turns it on; unset, nothing
runs. When on, it removes up to 500 such connections a day across all
organizations, each more than a day past its expiry, sign-in attempts first. An
attempt also named by a connection outside that daily batch stays with that
connection; the reviewed operation refuses the same shared attempt.

## Apply the reviewed plan

`released-interactive-retirement-v1` repairs one exact completed connection whose
retirement state is exactly `{ "removed": false }`. Back up that migration's
tables first. Use `prepare` with selection
`released-interactive-retirement-proof-v1` and the reviewed account, connection,
organization, actor, provider, method, generation, acquiring app/version and
reference checksum. Copy only the returned `snapshotSha256` into the same request
for the migration dry run. The reference itself stays inside the runtime.

The dry run proposes one connection update. Apply performs another Home read,
verifies the decrypted account reference, then rechecks the complete saved rows
under locks before removing only the released marker. Active or expired lease
objects, successful removals, ambiguous connections, changed rows and unavailable
Home references refuse. Credentials, account metadata, links and all other
provenance survive. Receipt replay verifies the committed result without repeating
the repair. After the repair, provider adoption needs a separate dry run with
current version bindings and its own GO.

Get the coordinator's GO for that exact plan hash. Dispatch the same migration
and request with `mode=apply`, `source_run` equal to the successful dry-run run ID,
`plan_sha256` equal to the reviewed plaintext plan checksum, and `go` exactly
`GO <plan_sha256>`.

The CLI verifies that the source was a successful main-branch dispatch of this
workflow and that its downloaded backup matches its checksum before sending
anything. The runtime refuses changed requests, deployments, revisions,
databases or inputs, and plans older than one hour. Database binding uses the
normalized direct origin and the connected database's identity, checked again
inside the write transaction. Credentials, URL options and Hyperdrive's temporary
proxy address do not identify the database. Password changes alone preserve its
database binding.
The migration bootstrap gives each database a persistent random UUID. The binding
includes that UUID and the connected login's role OID, plus the cluster identifier
when its query succeeds. This identifies the same dataset lineage. A byte-restored
clone can retain the UUID and catalog OIDs, so it can match when the server
identifier is unavailable. Apply still rechecks every reviewed row, scope and
stable key, with a plan younger than one hour. Fresh databases, different logins
and changed reviewed data are refused. Plans made before this identity format
was deployed require a fresh dry run. Existing
receipts keep their plan and backup hashes; no receipt schema changes.
It re-inspects inside the write transaction and verifies before and after commit.
A failed in-transaction verification rolls back the writes and receipt together.

There is no automatic retry. If an apply fails or its result is uncertain, run
`inventory` with selection `receipts` and inspect the exact plan hash privately
before deciding what to do next. A repeated, still-valid committed plan returns
its receipt and verifies again without replaying its writes. If the deployment
or plan validity changed, use the saved receipt and backup to prepare a reviewed
follow-up. Do not invent a new plan merely to repeat an uncertain mutation.

## Rotate identity after a restore

After restoring a database, rotate its identity row before running any
production-ops plan. Use the database connection authorized by the restore
procedure and run this transaction on the restored database:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
UPDATE production_ops_database_identity
SET id = gen_random_uuid(), created_at = now()
RETURNING id;
COMMIT;
```

Confirm that the update returned exactly one UUID. This invalidates pre-rotation
plans. Run a fresh dry run and obtain GO for its new plan hash. The workflow has
no arbitrary SQL action; this step belongs to the authorized restore procedure.

## Prove the migration boundary locally

After preparing the pinned upstream and its E2E assets, run
`node scripts/production-ops/prove-scope.ts`. It temporarily registers a synthetic
migration while the normal managed Cloud suite exercises signed dry-run, apply,
verification and replay requests. Runner-only controls vary passwords and logins,
switch the real SQL binding to another database with equivalent rows, and change
the declared origin or release. Signed requests still use the real HTTP handler
and SQL transactions. It restores the original registry, connection and release
declarations and removes both fixture modules afterward. The fixture
modules are never part of a carried patch or a deployment.
