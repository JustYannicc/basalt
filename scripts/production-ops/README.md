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
requires a reviewed recovery operation. Restoring the encrypted rows also needs
its own reviewed operation and GO.

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
