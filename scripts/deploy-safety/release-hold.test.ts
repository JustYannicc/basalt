// A release hold stops every release, including a roll-forward, while someone restores a backup
// and rolls back. Rollback jobs don't receive it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyCurrentRelease } from "./release-plan.ts";
import { assertNoReleaseHold } from "./runtime.ts";

const workflow = (name: string) => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");

test("a set release hold stops releases with a clear message, and an empty one doesn't", async () => {
  assert.throws(() => assertNoReleaseHold({ PRODUCTION_RELEASE_HOLD: "restoring backup" }), /on hold: PRODUCTION_RELEASE_HOLD is set/);
  assert.doesNotThrow(() => assertNoReleaseHold({ PRODUCTION_RELEASE_HOLD: "" }));
  assert.doesNotThrow(() => assertNoReleaseHold({ PRODUCTION_RELEASE_HOLD: "  " }));
  assert.doesNotThrow(() => assertNoReleaseHold({}));

  const previous = process.env.PRODUCTION_RELEASE_HOLD;
  process.env.PRODUCTION_RELEASE_HOLD = "1";
  try {
    // Every release command classifies first, so none reaches the ledger or rolls forward.
    await assert.rejects(classifyCurrentRelease("1".repeat(40)), /on hold/);
  } finally {
    if (previous === undefined) delete process.env.PRODUCTION_RELEASE_HOLD;
    else process.env.PRODUCTION_RELEASE_HOLD = previous;
  }
});

test("every release job receives the hold and the rollback workflow doesn't", () => {
  const hold = /PRODUCTION_RELEASE_HOLD: \$\{\{ vars\.PRODUCTION_RELEASE_HOLD \}\}/g;
  assert.equal(workflow("deploy").match(hold)?.length, 1);
  assert.equal(workflow("release-main").match(hold)?.length, 2);
  assert.equal(workflow("release-manual").match(hold)?.length, 2);
  assert.doesNotMatch(workflow("release-rollback"), /PRODUCTION_RELEASE_HOLD/);
});
