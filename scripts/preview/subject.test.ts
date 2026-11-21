import assert from "node:assert/strict";
import { test } from "node:test";
import { stackNameForStage } from "../release-barrier/release-stage.ts";
import {
  parseSubjectArgument,
  pullRequestSubject,
  rehearsalSubject,
  requireCleanupStage,
  requireDisposableStage,
  stageNames,
  subjectFromStage,
} from "./subject.ts";

test("a rehearsal gets its own stage, stack and resource names beside a PR of the same number", () => {
  assert.deepEqual(stageNames(rehearsalSubject(17)), {
    slug: "rehearsal-17",
    stage: "test-rehearsal-17",
    stack: "basalt-rehearsal",
    sourceNamespace: "basalt-preview-rehearsal-17-apps",
    databaseName: "basalt-preview-rehearsal-17",
  });
  assert.deepEqual(stageNames(17), {
    slug: "pr-17",
    stage: "test-pr-17",
    stack: "basalt",
    sourceNamespace: "basalt-preview-pr-17-apps",
    databaseName: "basalt-preview-pr-17",
  });
  for (const subject of [pullRequestSubject(17), rehearsalSubject(17)]) {
    const names = stageNames(subject);
    assert.equal(names.stack, stackNameForStage(names.stage));
    assert.deepEqual(subjectFromStage(names.stage), subject);
  }
});

test("only exact PR and rehearsal stages are disposable; malformed ones never pass as production", () => {
  assert.deepEqual(requireDisposableStage("test-pr-3"), { kind: "pr", number: 3 });
  assert.deepEqual(requireDisposableStage("test-rehearsal-3"), { kind: "rehearsal", number: 3 });
  for (const stage of [undefined, "production", "v2", "test-e2e-3", "test-preview-3", "basalt"])
    assert.throws(() => requireDisposableStage(stage), /restricted to PR and rehearsal stages/);
  for (const stage of [
    "test-pr-0",
    "test-pr-foo",
    "test-pr-3-other",
    "test-pr-99999999999999999999",
    "test-rehearsal-0",
    "test-rehearsal-12345678901",
    "test-rehearsal-",
  ]) {
    assert.throws(() => subjectFromStage(stage), /malformed/, stage);
    assert.throws(() => requireDisposableStage(stage), stage);
  }
});

test("CLI subjects are a bare PR number or rehearsal-N", () => {
  assert.deepEqual(parseSubjectArgument("17"), { kind: "pr", number: 17 });
  assert.deepEqual(parseSubjectArgument("rehearsal-17"), { kind: "rehearsal", number: 17 });
  for (const value of [undefined, "0", "-1", "pr-17", "rehearsal-0", "rehearsal-17/x", "--bad"])
    assert.throws(() => parseSubjectArgument(value), String(value));
  assert.throws(() => rehearsalSubject(12345678901), /Rehearsal number/);
});

test("the delete-only config refuses other stages and a stage that disagrees with ALCHEMY_STAGE", () => {
  assert.deepEqual(requireCleanupStage("test-rehearsal-9", "test-rehearsal-9"), {
    kind: "rehearsal",
    number: 9,
  });
  assert.deepEqual(requireCleanupStage("test-pr-9", "test-pr-9"), { kind: "pr", number: 9 });
  for (const stage of ["production", "v2", "test-e2e-9", "test-preview-9"])
    assert.throws(() => requireCleanupStage(stage, stage), /restricted to PR and rehearsal/);
  // A rehearsal run that loaded under the PR stack name must not read or delete there.
  assert.throws(() => requireCleanupStage("test-rehearsal-9", undefined), /does not match/);
  assert.throws(() => requireCleanupStage("test-rehearsal-9", "test-pr-9"), /does not match/);
  assert.throws(() => requireCleanupStage("test-pr-9", "test-rehearsal-9"), /does not match/);
});
