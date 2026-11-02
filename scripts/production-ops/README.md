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

Download the artifact, then decrypt its inventory into a private local file:

```sh
node scripts/production-ops/artifact.ts decrypt /private/path/operation.json /private/path/ops-recipient.pem https://app.signalbox.run /private/path/inventory.json
```

A selection exceeding its row or byte bound fails; it never claims to be a
complete truncated inventory. An absent table or unknown selection also fails.
Every operation requires an existing organization ID in its signed request.
There is no global inventory or discovery fallback.

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

Get the coordinator's GO for that exact plan hash. Dispatch the same migration
and request with `mode=apply`, `source_run` equal to the successful dry-run run ID,
`plan_sha256` equal to the reviewed plaintext plan checksum, and `go` exactly
`GO <plan_sha256>`.

The CLI verifies that the source was a successful main-branch dispatch of this
workflow and that its downloaded backup matches its checksum before sending
anything. The runtime refuses changed requests, deployments, revisions,
databases or inputs, and plans older than one hour. Database binding includes
fingerprints of the trusted runtime and direct connections, so a same-name
database on another target or a credential rotation requires a new dry-run.
It re-inspects inside the write transaction and verifies before and after commit.
A failed in-transaction verification rolls back the writes and receipt together.

There is no automatic retry. If an apply fails or its result is uncertain, run
`inventory` with selection `receipts` and inspect the exact plan hash privately
before deciding what to do next. A repeated, still-valid committed plan returns
its receipt and verifies again without replaying its writes. If the deployment
or plan validity changed, use the saved receipt and backup to prepare a reviewed
follow-up. Do not invent a new plan merely to repeat an uncertain mutation.

## Prove the migration boundary locally

After preparing the pinned upstream and its E2E assets, run
`node scripts/production-ops/prove-scope.ts`. It temporarily registers a synthetic
migration while the normal managed Cloud suite exercises signed dry-run, apply,
verification and replay requests. It restores the original registry and removes
the fixture module afterward. The proof module is never part of a carried patch
or a deployment.
