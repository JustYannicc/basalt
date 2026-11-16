import assert from "node:assert/strict";
import test from "node:test";
import { recoveryInvocation } from "./recorded-recovery-entry.ts";

const invocation = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/release-rollback.yml@refs/heads/main",
  RUNNER_TEMP: "/fixture/runner",
  RECOVERY_MODE: "recorded-versions",
  RECOVERY_CANDIDATE: "a".repeat(40),
  RECOVERY_SOURCE_RUN: "42/1",
  RECOVERY_PAIR_SHA256: "b".repeat(64),
  RECOVERY_DATABASE_COMPATIBLE: "true",
};

test("recorded recovery selects the exact release evidence and compatibility decision from the trusted workflow", () => {
  assert.deepEqual(recoveryInvocation(invocation), {
    candidate: "a".repeat(40),
    sourceRun: "42/1",
    pairSha256: "b".repeat(64),
    databaseCompatible: true,
  });
});

for (const change of [
  { GITHUB_ACTIONS: "false" },
  { GITHUB_EVENT_NAME: "push" },
  { GITHUB_REF: "refs/heads/feature" },
  { RECOVERY_MODE: "database-restore" },
  { GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/release-manual.yml@refs/heads/main" },
  { RESTORED_BACKUP: "a-database-restore-was-selected" },
  { RUNNER_TEMP: "relative" },
  { RECOVERY_DATABASE_COMPATIBLE: "unknown" },
])
  test(`recorded recovery refuses an ambiguous or untrusted invocation: ${Object.keys(change)[0]}`, () => {
    assert.throws(() => recoveryInvocation({ ...invocation, ...change }), /Recorded recovery/);
  });
