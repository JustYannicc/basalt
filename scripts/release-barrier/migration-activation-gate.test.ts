import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { exactMigrationRelease, migrationActivationInput } from "./migration-activation-gate.ts";

const environment = {
  BASALT_RELEASE_CANDIDATE: "a".repeat(40),
  MIGRATION_ACTIVATION_MODE: "plan",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "synthetic/basalt",
  GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/release-main.yml@refs/heads/main",
};

test("a successful containing release cannot substitute for the exact recorded candidate", () => {
  const candidate = environment.BASALT_RELEASE_CANDIDATE;
  assert.equal(
    exactMigrationRelease(candidate, { state: "ready", gitCommit: candidate, deploymentId: 42 }),
    42,
  );
  for (const ledger of [
    { state: "uninitialized" as const },
    { state: "unresolved" as const, gitCommit: candidate, deploymentId: 42 },
    { state: "ready" as const, gitCommit: "b".repeat(40), deploymentId: 43 },
    { state: "ready" as const, gitCommit: candidate, deploymentId: 0 },
  ])
    assert.throws(() => exactMigrationRelease(candidate, ledger), /wrong-production-candidate/);
});

test("only exact candidate plan, digest and inspect inputs enter the trusted activation job", () => {
  for (const mode of ["plan", "inspect", "b".repeat(64)])
    assert.deepEqual(
      migrationActivationInput({ ...environment, MIGRATION_ACTIVATION_MODE: mode }),
      {
        candidate: environment.BASALT_RELEASE_CANDIDATE,
        mode,
      },
    );
  for (const mode of ["", "apply", "Plan", "b".repeat(63), " b".repeat(32)])
    assert.throws(
      () => migrationActivationInput({ ...environment, MIGRATION_ACTIVATION_MODE: mode }),
      /mode-invalid/,
    );
  for (const candidate of ["", "main", "a".repeat(39), "a".repeat(40) + "\n"])
    assert.throws(
      () => migrationActivationInput({ ...environment, BASALT_RELEASE_CANDIDATE: candidate }),
      /candidate-required/,
    );
});

test("activation refuses PR, non-main and different workflow contexts before connecting", () => {
  for (const changed of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/other.yml@refs/heads/main" },
  ])
    assert.throws(
      () => migrationActivationInput({ ...environment, ...changed }),
      /trusted-workflow/,
    );
  assert.throws(
    () =>
      migrationActivationInput({ ...environment, BASALT_HOME_SCHEMA_RETRY_INTENT: "other-intent" }),
    /conflicting-input/,
  );
});

test("the activation workflow keeps the release lock and excludes all ordinary deployment work", () => {
  const require = createRequire(new URL("../architecture/package.json", import.meta.url));
  const { parse } = require("yaml");
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release-main.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.concurrency, {
    group: "deploy-production",
    "cancel-in-progress": false,
  });
  assert.match(workflow.jobs.backup.if, /inputs\.migration_activation == ''/);
  assert.match(workflow.jobs.deploy.if, /inputs\.migration_activation == ''/);
  const job = workflow.jobs["migration-activation"];
  assert.equal(job.environment, "production-release");
  assert.match(job.if, /inputs\.migration_activation != ''/);
  assert.equal(job.needs, undefined);
  const steps = job.steps;
  assert.equal(steps[0].with.ref, "${{ github.sha }}");
  const validate = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("migration-activation-gate.ts"),
  );
  const select = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("git worktree add"),
  );
  const run = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("migration-activation-entry.ts"),
  );
  assert.ok(validate > 0 && select > validate && run > select);
  assert.equal(steps[run]["working-directory"], "${{ runner.temp }}/candidate");
  const commands = steps.map((step: { run?: string }) => step.run ?? "").join("\n");
  assert.doesNotMatch(
    commands,
    /already-live|main-candidate\.ts newest|release\.ts deploy|backup-only|--apply|--activate-change-journal/,
  );
  assert.doesNotMatch(commands, /\$\{\{ inputs\./);
  assert.equal(steps[run].env.MIGRATION_ACTIVATION_MODE, "${{ inputs.migration_activation }}");
  const artifact = steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(artifact.if, "always()");
  assert.match(artifact.with.path, /migration-activation\.json$/);
});
