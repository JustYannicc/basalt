import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name: string) =>
  readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const rehearsal = read("release-rehearsal.yml");
const handoff = read("release-rehearsal-handoff.yml");
const cleanup = read("release-cleanup.yml");

test("a busy main never cancels a running rehearsal, and only the rehearsal label starts one on a PR", () => {
  assert.doesNotMatch(
    rehearsal,
    /^concurrency:/m,
    "workflow-level concurrency would let skipped runs cancel",
  );
  assert.match(
    rehearsal,
    /\n    concurrency:\n      group: release-rehearsal-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}-\$\{\{ matrix\.scenario \}\}\n      cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/,
  );
  assert.match(
    rehearsal,
    /github\.event\.action != 'labeled' \|\| github\.event\.label\.name == 'release-rehearsal' \|\|\n\s+github\.event\.label\.name == 'release-rehearsal-single-writer' \|\|\n\s+github\.event\.label\.name == 'release-rehearsal-single-writer-step4' \|\|\n\s+github\.event\.label\.name == 'release-rehearsal-native'/,
  );
  assert.match(
    rehearsal,
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'release-rehearsal-native'\) && '\["single-writer-native"\]'/,
  );
  assert.match(
    rehearsal,
    /'release-rehearsal-single-writer-step4'\) && '\["single-writer-resume","single-writer-rollback"\]'/,
  );
  assert.match(
    rehearsal,
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'release-rehearsal-single-writer'\) && '\["single-writer"\]'/,
  );
  assert.match(
    rehearsal,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
});

test("each attempt has its own stage, and its checkpoint is saved before anything is deployed", () => {
  assert.match(
    rehearsal,
    /rehearsal-stage\.ts "\$GITHUB_RUN_NUMBER" "\$GITHUB_RUN_ATTEMPT" "\$REHEARSAL_SCENARIO"/,
  );
  const upload = rehearsal.indexOf(
    "name: release-rehearsal-cleanup-${{ steps.stage.outputs.subject }}-${{ github.run_id }}",
  );
  const run = rehearsal.indexOf("run: node scripts/release-preview/rehearsal.ts");
  assert.ok(upload > 0 && upload < run);
  assert.match(
    rehearsal,
    /RELEASE_REHEARSAL_SENTRY_DSN: \$\{\{ secrets\.RELEASE_REHEARSAL_SENTRY_DSN \}\}/,
  );
  // Cleanup finds a passed scenario's receipt by its stage, so the name carries the attempt too.
  assert.match(rehearsal, /name: release-rehearsal-\$\{\{ steps\.stage\.outputs\.subject \}\}\n/);
  assert.doesNotMatch(
    rehearsal,
    /secrets\.(?:SENTRY_DSN|POOL_DEPLOYMENT_KEY|POOL_APP_SIGNING_KEY|EXECUTOR_ENCRYPTION_KEY)\b/,
  );
});

test("the handoff reads a completed main-push rehearsal and releases only with Check passed too", () => {
  assert.match(
    handoff,
    /^  workflow_run:\n    workflows: \[Release rehearsal\]\n    types: \[completed\]\n    branches: \[main\]$/m,
  );
  for (const term of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.path == '.github/workflows/release-rehearsal.yml'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ])
    assert.ok(handoff.includes(term), term);
  assert.match(handoff, /^          ref: main$/m);
  const gate = handoff.indexOf("rehearsal-gate.ts ready");
  const dispatch = handoff.indexOf("gh workflow run release-main.yml");
  assert.ok(gate > 0 && gate < dispatch);
  assert.match(
    handoff,
    /if: steps\.gate\.outputs\.ready == 'true'\n        run: gh workflow run release-main\.yml/,
  );
});

test("rehearsal cleanup runs for every unfinished rehearsal and never for a skipped or passed one", () => {
  const job = cleanup.slice(cleanup.indexOf("\n  rehearsal-cleanup:\n"));
  assert.match(cleanup, /workflows: \[Release preview, Release rehearsal\]/);
  for (const term of [
    "github.event.workflow_run.name == 'Release rehearsal'",
    "github.event.workflow_run.conclusion != 'success'",
    "github.event.workflow_run.conclusion != 'skipped'",
  ])
    assert.ok(job.includes(term), term);
  assert.match(job, /^          ref: main$/m);
  assert.match(job, /run: node scripts\/release-preview\/rehearsal-cleanup\.ts/);
  assert.ok(
    cleanup
      .slice(0, cleanup.indexOf("\n  rehearsal-cleanup:\n"))
      .includes("github.event.workflow_run.name == 'Release preview'"),
  );
});

test("a cancelled, timed-out or failed rehearsal is torn down by its own run", () => {
  const job = rehearsal.slice(rehearsal.indexOf("\n  cleanup:\n"));
  assert.match(
    job,
    /\n    needs: rehearsal\n    if: always\(\) && needs\.rehearsal\.result != 'success' && needs\.rehearsal\.result != 'skipped'\n/,
  );
  assert.match(job, /run: node scripts\/release-preview\/rehearsal-cleanup\.ts/);
  assert.match(rehearsal, /\n    timeout-minutes: 360\n/);
});
