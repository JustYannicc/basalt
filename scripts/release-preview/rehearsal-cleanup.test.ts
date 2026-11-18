import assert from "node:assert/strict";
import { test } from "node:test";
import { ownRehearsalRun, provenTeardown, rehearsalCheckpoints, rehearsalCleanupRun } from "./rehearsal-cleanup.ts";

const repository = "owner/basalt";
const event = (run: Record<string, unknown>) => ({
  repository: { full_name: repository },
  workflow_run: {
    id: 99,
    name: "Release rehearsal",
    path: ".github/workflows/release-rehearsal.yml",
    status: "completed",
    conclusion: "cancelled",
    head_repository: { full_name: repository },
    ...run,
  },
});

test("only an unsuccessful run of this repository's rehearsal workflow is cleaned up", () => {
  assert.equal(rehearsalCleanupRun(event({}), repository), 99);
  assert.equal(rehearsalCleanupRun(event({ conclusion: "failure" }), repository), 99);
  for (const run of [
    { conclusion: "success" },
    { name: "Release preview" },
    { path: ".github/workflows/other.yml" },
    { status: "in_progress" },
    { head_repository: { full_name: "fork/basalt" } },
    { id: 0 },
  ])
    assert.throws(() => rehearsalCleanupRun(event(run), repository), /Invalid rehearsal cleanup event/);
});

test("each checkpoint artifact of exactly that run names one rehearsal stage", () => {
  const found = rehearsalCheckpoints(
    [
      { id: 1, name: "release-rehearsal-cleanup-rehearsal-8121-99", expired: false },
      { id: 2, name: "release-rehearsal-cleanup-rehearsal-8122-99", expired: false },
      { id: 3, name: "release-rehearsal-cleanup-rehearsal-8123-98", expired: false },
      { id: 4, name: "release-rehearsal-cleanup-rehearsal-8124-99", expired: true },
      { id: 5, name: "release-preview-cleanup-12-99", expired: false },
      { id: 6, name: "release-rehearsal-cleanup-pr-12-99", expired: false },
    ],
    99,
  );
  assert.deepEqual(found, [
    { id: 1, subject: { kind: "rehearsal", number: 8121 } },
    { id: 2, subject: { kind: "rehearsal", number: 8122 } },
  ]);
  assert.throws(() => rehearsalCheckpoints({}, 99), /Invalid/);
  assert.throws(() => rehearsalCheckpoints(Array.from({ length: 100 }, () => ({})), 99), /Invalid/);
});

test("only a receipt for exactly that stage with verified teardown skips its cleanup", () => {
  const subject = { kind: "rehearsal", number: 8121 } as const;
  assert.equal(provenTeardown({ version: 1, stage: "test-rehearsal-8121", teardown: true }, subject), true);
  for (const receipt of [
    undefined,
    { version: 1, stage: "test-rehearsal-8122", teardown: true },
    { version: 1, stage: "test-rehearsal-8121", teardown: false },
    { version: 2, stage: "test-rehearsal-8121", teardown: true },
  ])
    assert.equal(provenTeardown(receipt, subject), false);
});

test("the rehearsal's own cleanup job cleans only its own run", () => {
  const env = { GITHUB_JOB: "cleanup", GITHUB_RUN_ID: "99", GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-rehearsal.yml@refs/pull/7/merge` };
  assert.equal(ownRehearsalRun(env, repository), 99);
  for (const change of [{ GITHUB_JOB: "rehearsal" }, { GITHUB_RUN_ID: "0" }, { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy.yml@refs/heads/main` }])
    assert.throws(() => ownRehearsalRun({ ...env, ...change }, repository), /Invalid rehearsal cleanup event/);
});
