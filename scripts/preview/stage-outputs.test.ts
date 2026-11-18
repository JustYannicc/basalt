import assert from "node:assert/strict";
import { test } from "node:test";
import { rehearsalOutputStacks } from "./stage-outputs.ts";

const stages: Record<string, readonly string[]> = {
  "basalt-rehearsal-runtime-image-release": ["test-rehearsal-81211", "test-rehearsal-81221"],
  "basalt-rehearsal-release-barrier": ["test-rehearsal-81211"],
  "basalt-rehearsal-fixture": ["test-rehearsal-81211"],
  "basalt-runtime-image-release": ["production"],
  "basalt-release-barrier": ["production", "test-rehearsal-81211"],
  "basalt-rehearsal": ["test-rehearsal-81211"],
};

test("only this rehearsal stage's barrier output stacks are named for removal", async () => {
  const present = await rehearsalOutputStacks("test-rehearsal-81211", Object.keys(stages), async (stack) => stages[stack] ?? []);
  assert.deepEqual(present, ["basalt-rehearsal-runtime-image-release", "basalt-rehearsal-release-barrier"]);
  assert.deepEqual(
    await rehearsalOutputStacks("test-rehearsal-99991", Object.keys(stages), async (stack) => stages[stack] ?? []),
    [],
  );
  for (const stage of ["production", "test-pr-12"])
    await assert.rejects(rehearsalOutputStacks(stage, Object.keys(stages), async () => [stage]), /only for rehearsal stages/);
});
