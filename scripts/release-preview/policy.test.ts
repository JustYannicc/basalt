import assert from "node:assert/strict";
import { test } from "node:test";
import { compilerPreviewEnvironment, requireCompilerPreviewIdentity } from "./policy.ts";

const head = "a".repeat(40);
const source = {
  GITHUB_ACTIONS: "true",
  EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE: "true",
  BASALT_RELEASE_CANDIDATE: head,
};

test("ordinary previews ignore inherited release and compiler cache bindings", () => {
  assert.deepEqual(
    compilerPreviewEnvironment(
      {
        BASALT_RELEASE_CANDIDATE: head,
        EXECUTOR_COMPILER_CACHE_RELEASE: head,
      },
      "test-pr-42",
    ),
    {},
  );
  assert.doesNotThrow(() => requireCompilerPreviewIdentity({}, {}, { pullRequest: 42, head }));
});

test("acceptance forwards only its flag and exact release for a PR stage", () => {
  assert.deepEqual(
    compilerPreviewEnvironment({ ...source, UNKNOWN_FUTURE_SECRET: "private" }, "test-pr-42"),
    {
      EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE: "true",
      BASALT_RELEASE_CANDIDATE: head,
    },
  );
  assert.doesNotThrow(() =>
    requireCompilerPreviewIdentity(source, { compilerAcceptance: true }, { pullRequest: 42, head }),
  );
});

test("acceptance refuses production, foreign stages, missing release and non-Actions execution", () => {
  for (const stage of ["production", "test-42", "test-pr-0", "test-pr-42-extra"]) {
    assert.throws(() => compilerPreviewEnvironment(source, stage), /Compiler acceptance requires/);
  }
  for (const override of [
    { EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE: "false" },
    { BASALT_RELEASE_CANDIDATE: undefined },
    { BASALT_RELEASE_CANDIDATE: "main" },
    { GITHUB_ACTIONS: undefined },
    { ALCHEMY_STAGE: "production" },
    { ALCHEMY_STAGE: "test-pr-43" },
  ]) {
    assert.throws(
      () => compilerPreviewEnvironment({ ...source, ...override }, "test-pr-42"),
      /Compiler acceptance requires/,
    );
  }
});

test("the run cannot upgrade an ordinary or different-head receipt to acceptance", () => {
  const identity = { pullRequest: 42, head };
  assert.throws(() => requireCompilerPreviewIdentity(source, {}, identity), /does not match/);
  assert.throws(
    () => requireCompilerPreviewIdentity({}, { compilerAcceptance: true }, identity),
    /does not match/,
  );
  assert.throws(
    () =>
      requireCompilerPreviewIdentity(
        { ...source, BASALT_RELEASE_CANDIDATE: "b".repeat(40) },
        { compilerAcceptance: true },
        identity,
      ),
    /does not match/,
  );
});
