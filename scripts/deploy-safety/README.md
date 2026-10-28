# Production release safety

These scripts run inside the production GitHub Actions workflow. They read the latest successful GitHub production deployment as the release baseline, classify the candidate against that commit, and keep a small rollback record in GitHub Deployments. The record contains only public commit pins, the source classification, a report digest and, for a database change, the backup name and metadata.

## Workflow contract

Run candidate preparation, checks and builds before the protected production deployment job. For a manual candidate, check out its exact PR commit into a separate directory under `RUNNER_TEMP`. Keep the workflow files and this safety runner on trusted `main`.

The production job uses the `production-release` GitHub Environment, which restricts deployment to trusted `main` workflow dispatches. It has no required reviewer, so manual releases, rollbacks and credential export run straight through after their own checks (and, for a release, its backup). The runner does not wait for an approval. On `main` no one dispatches a release: Deploy starts the manual path itself. Code enforces what it can observe: the backup, the classification, and Workflow drain, which is described below. Nothing quiesces writes, so a database-changing release migrates production while it serves. Nothing proves that a database was restored.

Required GitHub permissions:

- `contents: read`
- `deployments: write`
- `actions: read`, to see whether the run that owns an unfinished deployment record has completed

Pass the built-in `GITHUB_TOKEN` and `GITHUB_REPOSITORY`; Actions also sets `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`, which the runner records. PlanetScale calls use the existing `PLANETSCALE_ORGANIZATION`, `PLANETSCALE_API_TOKEN_ID`, and `PLANETSCALE_API_TOKEN` secrets. The request header is PlanetScale's service-token format, `<ID>:<TOKEN>`.

### Candidate report

```sh
node scripts/deploy-safety/release.ts latest-base
node scripts/deploy-safety/release.ts report \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  > "$RUNNER_TEMP/release-report.json"
```

`latest-base` reports the last successful production commit. If the latest deployment is unresolved, it reports the prior successful baseline with an unresolved state; every release guard still blocks until that deployment is reconciled, unless the release is rolling forward over it (see [Rolling forward over a failed release](#rolling-forward-over-a-failed-release)). With no deployment record, or when every record ended as a failed or errored attempt that never reported success, the runner checks PlanetScale and accepts an initial baseline only when the production database is absent. A pending, in-progress, status-less or hand-set inactive record, or any failure after a successful release, stays unresolved. Each of those attempts checked absence before it deployed and recorded its start before it could create the database, so a retry also continues when the production database was created inside a failed attempt's window, between its start and its final status. A database created at any other time, or without a creation time, still stops the release. A retry against such a database is still classified as an initial release, so if a failed first attempt had already gone live before failing its smoke check, a later database change would not take a backup; that case needs a manual check.

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

Automatic mode accepts a `push` or bootstrap `workflow_dispatch` from `refs/heads/main` only when both `databaseChanged` and `workflowChanged` are false. Risky reports go through the separate manual release workflow. On `main`, the Deploy workflow starts `Manual release of main` itself when the report needs it, as long as its candidate is still the `main` head. It validates deployment configuration before creating a deployment record, deploys, runs the public smoke check, and marks the record successful.

The deploy step retries one failure, in both modes: when Cloudflare rejects a Worker upload with `ScriptStartupError` because script startup exceeded the CPU time limit, the runner logs a warning and runs the deploy command once more under the same deployment record. Startup CPU time varies between uploads. The retry runs the whole deploy again, so the steps that always run, such as Migrations, PoolDatabase and AppSourceNamespace, run a second time. It needs both the error name and that message in the failed command's output, and it needs the first attempt to have finished: when something the deploy started still holds its output two seconds after it exits, the runner logs why and doesn't retry, so the two can't overlap. No other failure, including another `ScriptStartupError`, is retried, and a second rejection fails the step. Rollback deploys retry the same way.

If deployment or smoke starts and fails for a safe release, the runner marks that attempt failed, fetches the recorded base commit into an isolated temporary worktree, prepares and builds its pins, deploys them, runs smoke, then records a successful rollback. Preparation or guard failures do not start a rollback. Release subprocesses run quietly. Actions logs are public, so a failed command prints the last 60 lines of its stdout and stderr separately, starting at a whole line, after removing credential-named environment values, URL userinfo, bearer and basic credentials, key-value pairs whose key ends in password, secret, token or api key, and long runs mixing letters and digits. The runner settles when the command exits, so a leftover descendant holding its output cannot keep the release open. If the rollback build or deploy fails, the failure remains visible in GitHub Deployments and the next release is blocked until recovery.

### Rolling forward over a failed release

A failed release can leave production mixed, with some Workers new and some old, and its migrations and data steps partly or fully applied. The next release on `main` rolls forward over it instead of waiting for someone to reconcile the record, when all of these hold:

- It is the only deployment record since the last success: a release record (not a rollback) whose latest status is `failure` or `error` and that never reported `success`. A pending, queued, in-progress, status-less or `inactive` record is never rolled forward over. If a second record lands after that success, which happens when the release rolling forward fails too, nothing is rolled forward and a person decides.
- It recorded the last success as its base, with the same pins.
- Its commit is the commit now being released, or an ancestor of it, by `git merge-base --is-ancestor` in the trusted checkout. A commit on another branch, a `main` rewritten since, or a commit Git can't find or compare leaves the failure unresolved.
- The release keeps the failed release's gates. If the failed release changed the database or a Workflow identity and the new report doesn't, as after a revert, rolling forward would skip the backup or the drain check, so the failure stays unresolved. This is checked after classification and again when the deployment record is created.
- No release hold is set (see [Release hold](#release-hold)).

A failed release from `Manual release` of a pull request records that PR's head commit. A squash merge puts a different commit on `main`, so the next `main` release doesn't contain it and doesn't roll forward over it. Only a re-release of that PR's branch, whose head contains the failed commit, rolls forward.

The ledger then reads as ready at the last success. The base stays the last success, so the release is classified against it, backed up when it changes the database, and recorded against it. It contains everything the failed release did, so its deploy re-applies the failed release's migrations and data steps and finishes whatever they left half done. `report` logs the failed record it rolls forward over, or why it can't. Rolling forward is checked again when the deployment record is created. `latest-base` has no candidate to compare, so it still reports the failure as unresolved.

Rolling forward keeps the failed release's database writes. It relies on migrations and data steps being forward-only, which the pinned upstream follows by convention; nothing here checks it per release:

- The hosted product migrations are an append-only list run once each, journaled in `private_hosted_migrations` and `private_cloud_migrations` in the same transaction as their changes, with no down step.
- Better Auth's migrator only adds what its options require. FumaDB migrates its tables forward to the current schema; its API also has `down`, but deploys never call it.
- Data steps are journaled in `private_hosted_data_steps`, keyed by an immutable name, and run once to completion; their contract says to append new steps and never rename or change one that has applied. `CLOUD_DATA_STEPS` keeps new steps in report mode until a deploy approves them.
- Basalt's pool database setup (`scripts/ensure-pool-database.ts`) creates only what is missing and runs on every deploy.

A carried patch that adds a migration or data step must keep that shape. Undoing a failed release's database writes is a deliberate rollback: dispatch `Manual production rollback` and restore the recorded backup. Rollback commands never roll forward over anything, so they still see the failure.

A re-release of the same base and candidate after rolling forward reuses the failed attempt's backup, because the backup name is derived from the transition.

When the failed release took a database backup, the release that rolls forward over it records that backup in its deployment payload as `rollbackBackup`, with the failed commit as `rollForwardOf`. The release's own backup was taken after the failed release's writes, so restoring it would pair the old code with the failed release's schema. `rollback-target`, `manual-rollback` and the rollback's backup check use `rollbackBackup` instead. It is verified to be the failed release's backup from the same base and pins, and `--restored-backup` must name it.

### Killed release jobs

A release job that is killed hard, by a lost runner, a timeout or a cancel, can't mark its deployment record failed, so the record stays `in_progress` (or `queued`, `pending`, or without a status) and blocks every release. Every record the runner creates names its run attempt in its payload as `run: { repository, id, attempt }`, and each status it posts links to that attempt (`https://github.com/<owner>/<repo>/actions/runs/<id>/attempts/<n>`). Parsing checks the identity's shape and fails the read when it's malformed.

When the latest record is unfinished, comes after a successful deployment and names a run attempt, the ledger asks the Actions API for that attempt. If it has `completed`, with any conclusion, the record reads as failed, and roll-forward and manual rollback treat it like any other failed release. It stays unresolved when:

- the attempt is still queued, waiting or running;
- the API errors, or answers about another run, attempt or repository;
- the identity names a repository other than this one;
- the record has no run identity, as older records don't;
- there is no previous successful deployment.

The failure is read in memory only: nothing writes a status back to the stale record. Once the next release begins, its own record is the latest one, so the stale record no longer matters.

### Release hold

Set the `PRODUCTION_RELEASE_HOLD` repository variable to any non-empty value to stop every release, including a roll-forward, while someone restores a backup by hand. The Deploy, `Manual release of main` and `Manual release` jobs receive it, and their release commands (`report`, `backup-only`, `inspect-workflows`, `deploy`, and creating the deployment record) stop with a clear message. `Manual production rollback` doesn't receive it, so the rollback still runs. The order is:

1. Set the hold.
2. Restore the recorded backup.
3. Dispatch `Manual production rollback`.
4. Clear the hold once the rollback has succeeded.

### Database or Workflow identity changes

The classifier's current report is the decision input. When either change flag is true, the release updater must keep the PR open, apply the relevant `database-change` and/or `workflow-identity-change` labels plus `manual-release`, and refrain from auto-merging it. These labels do not authorize deployment.

On a manual `workflow_dispatch`, run a backup-only job before the protected production job:

```sh
node scripts/deploy-safety/release.ts backup-only \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

For a database change, the command takes a PlanetScale Postgres branch backup, waits until its state is `success`, protects it from deletion and reads it back. The backup name identifies the exact release transition; see [Backup name and metadata](#backup-name-and-metadata). The PlanetScale backup API is branch scoped, so the backup covers the production branch containing both logical databases, `postgres` and `basalt_pool`. The protected backup remains at PlanetScale, independent of the Actions run.

Once the backup job has finished, the manual deploy job runs:

```sh
node scripts/deploy-safety/release.ts deploy \
  --mode manual \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

The source directory must be under `RUNNER_TEMP` and its Git `HEAD` must exactly match the report candidate. The runner checks that the current baseline and classification still match and verifies the protected backup before starting a database-changing deployment. A manual release failure is recorded but never automatically rolled back. The next release that contains it rolls forward over it; until then, or when that fails too, it stays unresolved until someone acts.

Workflow updates require the exact step name:

`Journal changes require all existing workflow runs drained before deployment`

The read-only inspection command uses Cloudflare's documented account Workflow list and per-Workflow instance list APIs, follows every page, validates status fields and reports unresolved counts:

```sh
node scripts/deploy-safety/release.ts inspect-workflows \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

For a Workflow-identity release, the command fails if any listed instance is not `complete`, `terminated` or `errored` (for example queued, running, paused, waiting or unknown), so the deploy step never runs. An `errored` instance has stopped and re-runs only if someone restarts it, so it doesn't block. Don't restart one across an identity change. Drain or terminate those instances, then dispatch again. Cloudflare exposes no atomic control that prevents new Workflow instances or timer starts while deployment changes the journal identity, so an empty listing is only an observation. Nothing stops new work first, so a Workflow can start between the listing and the deploy. The deployment report and CLI never state that the listing made the window race free.

### Manual rollback

For a database-changing release, get the exact protected recovery target with:

```sh
node scripts/deploy-safety/release.ts rollback-target \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --report "$RUNNER_TEMP/release-report.json"
```

Database restore stays manual in v1, done by whoever dispatches. PlanetScale restores a backup to a new branch. The current Alchemy `PostgresRole` resources resolve an omitted branch name to `main`, so selecting a newly restored branch as the provider default does not prove those existing role resources will follow it. Do not let the runner issue a restore or describe that rollback as complete.

After whoever dispatches has restored the recorded backup, verified the intended production branch and prepared the old pins, run `manual-rollback` inside the `workflow_dispatch` job to create the rollback deployment record. For a non-database rollback, no database restore step or `--restored-backup` is required. A rollback that crosses a Workflow identity change runs the same drain check as a release and stops while instances remain. The parent workflow deploys the recorded base pins, runs smoke and completes that record.

Pass the same immutable candidate worktree and SHA to the ledger command:

```sh
node scripts/deploy-safety/release.ts manual-rollback \
  --candidate "$CANDIDATE_SHA" \
  --candidate-root "$RUNNER_TEMP/candidate" \
  --restored-backup "$RESTORED_BACKUP" \
  --report "$RUNNER_TEMP/release-report.json"
```

The `manual-rollback` command reclassifies the exact report against the failed release and its last successful base. It records the rollback transition after the restore, which the dispatcher has already done. No one approves the rollback job. Instead, for a database rollback `--restored-backup` must equal the backup name the release recorded, or the command fails before deploying. `rollback-target` checks the same value when it's given, and the rollback workflow passes it to both. The name is the dispatcher's statement of what they restored, not a receipt: nothing reads the restore back.

### Backup name and metadata

A release backup is named `basalt-release-v2-<digest>`, 61 characters. The digest is the unpadded base64url SHA-256 of the backup metadata, serialized as JSON with sorted keys. The metadata holds the base and candidate Git SHAs and provider pins, the database scope with both logical databases and the production branch name, and that branch's cluster size and replica topology when the backup was taken. A name longer than 64 characters is refused before the backup is requested. PlanetScale rejects long names with HTTP 422, so the name can't carry the metadata itself.

The full metadata is stored in the GitHub deployment payload as `backupMetadata`, next to `backupName`. Every read of a recorded backup checks that the metadata's digest equals the digest in the name and that the metadata names the same transition as the payload: base and candidate commits, base pins and, for a release, candidate pins. The deploy runner passes the verified backup to the release record, and a rollback record copies it from the release it rolls back.

Matching is exact:

- `backup-only` recomputes the expected name from the report and the current production branch, then reuses or creates exactly that backup.
- Before a database-changing deploy, the production branch's expected name is recomputed from the report and that branch's current context. Backups on other branches don't count. If the branch was resized between backup and deploy, nothing matches and the deploy stops.
- `rollback-target` and `manual-rollback` use the backup the release recorded in GitHub Deployments and look only on the branch it names, so a later resize or a restore that moved production doesn't hide it.

Exactly one backup must match. Other backups, such as PlanetScale's own, are ignored. A malformed `basalt-release-` name, a digest mismatch, missing or orphaned payload metadata, or more than one match stops the release. The earlier `basalt-release-v1-` format embedded compressed metadata in the name. Those names can still be read and count only when the release recorded them; new backups always use v2.

## Provider contracts

- [PlanetScale service-token authorization](https://planetscale.com/docs/api/reference/service-tokens): `Authorization: <SERVICE_TOKEN_ID>:<SERVICE_TOKEN>`.
- [PlanetScale backups](https://planetscale.com/docs/postgres/backups): backups are created and restored at the database-branch level; protected backups retain their data and WAL files.
- [PlanetScale backup API](https://planetscale.com/docs/api/reference/create_backup): create, list and read a database-branch backup and inspect its state.
- [Cloudflare Workflow list](https://developers.cloudflare.com/api/resources/workflows/methods/list/) and [instance list](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/list/): the runner validates pagination and status data and fails on uncertainty.
