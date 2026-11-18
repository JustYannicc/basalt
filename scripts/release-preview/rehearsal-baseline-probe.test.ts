import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { rehearsalBaselineProbe } from "./rehearsal-baseline-probe.ts";

test("the rehearsal's probe refuses before listing anything unless the rehearsal job runs it on its candidate", async () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const trusted = {
    GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "JustYannicc/basalt", GITHUB_JOB: "rehearsal",
    GITHUB_WORKFLOW_REF: "JustYannicc/basalt/.github/workflows/release-rehearsal.yml@refs/pull/7/merge",
    ALCHEMY_STAGE: "test-rehearsal-42", BASALT_RELEASE_CANDIDATE: head,
  };
  for (const change of [
    { GITHUB_JOB: "release" },
    { ALCHEMY_STAGE: undefined },
    { ALCHEMY_STAGE: "production" },
    { GITHUB_WORKFLOW_REF: "JustYannicc/basalt/.github/workflows/release-main.yml@refs/heads/main" },
    { GITHUB_ACTIONS: "false" },
  ])
    assert.deepEqual(
      (await rehearsalBaselineProbe({ ...trusted, ...change }, process.cwd())).map(({ ok, reason, attempts }) => ({ ok, reason, attempts })),
      [{ ok: false, reason: "untrusted-rehearsal-context", attempts: 0 }],
    );
  // Trusted but without credentials it still refuses before any request.
  assert.equal((await rehearsalBaselineProbe(trusted, process.cwd()))[0]!.reason, "missing-release-credentials");
});
