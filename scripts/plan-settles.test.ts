import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverPlanSettlesProof } from "./architecture/native-stack.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

for (const shape of ["production", "preview"] as const)
  test(`${shape}: a plan right after an apply changes no resource`, { timeout: 80_000 }, () => {
    const proof = discoverPlanSettlesProof(root, shape);
    assert.deepEqual(
      { failed: proof.failed, error: proof.error, detail: proof.detail },
      { failed: undefined, error: undefined, detail: undefined },
    );
    assert.ok(proof.resources > 50, "the whole stack is planned, not a part of it");
    for (const [name, plan] of [
      ["the same release attempt", proof.afterApply],
      ["a new release attempt", proof.nextAttempt],
    ] as const) {
      assert.deepEqual(
        plan.filter((row) => !row.type.startsWith("Command.")),
        [],
        `a resource still plans as changed with ${name}`,
      );
      // A plan cannot know the outcome of a command that runs on every plan, so every resource
      // waiting on one would plan as an update forever.
      assert.deepEqual(
        plan.filter((row) => row.readers.length > 0),
        [],
        `a resource waits on a command that runs on every plan with ${name}`,
      );
    }
  });
