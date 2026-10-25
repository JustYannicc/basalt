# Production release safety

These scripts run inside the production GitHub Actions workflow. They read the latest successful GitHub production deployment as the release baseline, classify the candidate against that commit, and keep a small rollback record in GitHub Deployments. The record contains only public commit pins, the source classification, and a report digest.

## Workflow contract

Run candidate preparation, checks and builds before the protected production deployment job. For a manual candidate, check out its exact PR commit into a separate directory under `RUNNER_TEMP`. Keep the workflow files and this safety runner on trusted `main`.

The production job uses the protected `production-release` GitHub Environment. The Environment must restrict deployment to trusted `main` workflow dispatches and require the configured reviewer. This provides the human release decision. The runner does not claim the Environment approval proves Workflow drain or database restoration.

Required GitHub permissions:

- `contents: read`
- `deployments: write`

Pass the built-in `GITHUB_TOKEN` and `GITHUB_REPOSITORY`. PlanetScale calls use the existing `PLANETSCALE_ORGANIZATION`, `PLANETSCALE_API_TOKEN_ID`, and `PLANETSCALE_API_TOKEN` secrets. The request header is PlanetScale's service-token format, `<ID>:<TOKEN>`.

### Candidate report

```sh
node scripts/deploy-safety/release.ts latest-base
node scripts/deploy-safety/release.ts report \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  > "$RUNNER_TEMP/release-report.json"
```

`latest-base` reports the last successful production commit. If the latest deployment is unresolved, it reports the prior successful baseline with an unresolved state; every release guard still blocks until that deployment is reconciled. With no deployment record, or when every record ended as a failed or errored attempt that never reported success, the runner checks PlanetScale and accepts an initial baseline only when the production database is absent. A pending, in-progress, status-less or hand-set inactive record, or any failure after a successful release, stays unresolved. A failed first attempt that already created the production database still needs a manual decision.

`report` runs the classifier bundled with the trusted workflow checkout, reads candidate files by exact Git commit, and emits schema version 1 JSON. Manual runs pass `--candidate-root "$RUNNER_TEMP/candidate"`; automatic reports use the trusted checkout and need no candidate root. A bootstrap `workflow_dispatch` from `main` may classify that trusted checkout by passing the exact `GITHUB_SHA`. `unknown` database or Workflow evidence is a change. The report is safe to retain as an Actions artifact because it contains source paths, public pins and hashes, without database URLs, credentials or application data.

The deployment job downloads the report, passes the same candidate SHA and recomputes it against the current production ledger. Any source, pin, evidence, candidate or baseline drift fails closed.

### Normal releases

After checks pass on the push to `main`, use:

```sh
node scripts/deploy-safety/release.ts deploy \
  --mode automatic \
  --candidate "$GITHUB_SHA" \
  --report "$RUNNER_TEMP/release-report.json"
```

Automatic mode accepts a `push` or bootstrap `workflow_dispatch` from `refs/heads/main` only when both `databaseChanged` and `workflowChanged` are false. Risky reports still require the separate protected manual release workflow. It validates deployment configuration before creating a deployment record, deploys, runs the public smoke check, and marks the record successful.

If deployment or smoke starts and fails for a safe release, the runner marks that attempt failed, fetches the recorded base commit into an isolated temporary worktree, prepares and builds its pins, deploys them, runs smoke, then records a successful rollback. Preparation or guard failures do not start a rollback. Release subprocesses run quietly. Actions logs are public, so a failed command prints the last 60 lines of its stdout and stderr separately, starting at a whole line, after removing credential-named environment values, URL userinfo, bearer and basic credentials, key-value pairs whose key ends in password, secret, token or api key, and long runs mixing letters and digits. The runner settles when the command exits, so a leftover descendant holding its output cannot keep the release open. If the rollback build or deploy fails, the failure remains visible in GitHub Deployments and the next release is blocked until recovery.

### Database or Workflow identity changes

The classifier's current report is the decision input. When either change flag is true, the release updater must keep the PR open, apply the relevant `database-change` and/or `workflow-identity-change` labels plus `manual-release`, and refrain from auto-merging it. These labels do not authorize deployment.

On a manual `workflow_dispatch`, run a backup-only job before the protected production job:

```sh
node scripts/deploy-safety/release.ts backup-only \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

For a database change, the command takes a PlanetScale Postgres branch backup, waits until its state is `success`, protects it from deletion and reads it back. The backup name carries the exact before and after Git SHAs and provider pins. The PlanetScale backup API is branch scoped, so the backup covers the production branch containing both logical databases, `postgres` and `basalt_pool`. The protected backup remains at PlanetScale, independent of the Actions run.

After the protected Environment approves the manual deploy job, use:

```sh
node scripts/deploy-safety/release.ts deploy \
  --mode manual \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

The source directory must be under `RUNNER_TEMP` and its Git `HEAD` must exactly match the report candidate. The runner checks that the current baseline and classification still match and verifies the protected backup before starting a database-changing deployment. A manual release failure is recorded but never automatically rolled back.

Workflow updates require the exact step name:

`Journal changes require all existing workflow runs drained before deployment`

The read-only inspection command uses Cloudflare's documented account Workflow list and per-Workflow instance list APIs, follows every page, validates status fields and reports unresolved counts:

```sh
node scripts/deploy-safety/release.ts inspect-workflows \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

Cloudflare exposes no atomic control that prevents new Workflow instances or timer starts while deployment changes the journal identity. An empty listing is only an observation. For v1, the approved operator drains or quarantines starts manually after the inspection. The deployment report and CLI never state that the listing made the window race free.

### Manual rollback

For a database-changing release, get the exact protected recovery target with:

```sh
node scripts/deploy-safety/release.ts rollback-target \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

Database restore stays operator owned in v1. PlanetScale restores a backup to a new branch. The current Alchemy `PostgresRole` resources resolve an omitted branch name to `main`, so selecting a newly restored branch as the provider default does not prove those existing role resources will follow it. Do not let the runner issue a restore or describe that rollback as complete.

After the operator has restored the recorded backup, verified the intended production branch and prepared the old pins, run `manual-rollback` inside the protected `workflow_dispatch` job to create the rollback deployment record. For a non-database rollback, no database restore step is required. The parent workflow deploys the recorded base pins, runs smoke and completes that record.

Pass the same immutable candidate worktree and SHA to the ledger command:

```sh
node scripts/deploy-safety/release.ts manual-rollback \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

The `manual-rollback` command reclassifies the exact report against the failed release and its last successful base. It records the rollback transition after the parent workflow's operator-owned restore step. It has no environment variable, shell hook or caller-supplied “restore succeeded” receipt.

## Provider contracts

- [PlanetScale service-token authorization](https://planetscale.com/docs/api/reference/service-tokens): `Authorization: <SERVICE_TOKEN_ID>:<SERVICE_TOKEN>`.
- [PlanetScale backups](https://planetscale.com/docs/postgres/backups): backups are created and restored at the database-branch level; protected backups retain their data and WAL files.
- [PlanetScale backup API](https://planetscale.com/docs/api/reference/create_backup): create, list and read a database-branch backup and inspect its state.
- [Cloudflare Workflow list](https://developers.cloudflare.com/api/resources/workflows/methods/list/) and [instance list](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/list/): the runner validates pagination and status data and fails on uncertainty.
