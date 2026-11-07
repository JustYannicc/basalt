import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverContainerBarrierProof } from "../architecture/native-stack.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const scenario of [
  "success",
  "unhealthy-serving",
  "same-digest",
  "late-worker-rejection",
  "missing-startup",
  "over-ceiling",
  "container-drift",
  "source-drift",
  "native-state-drift",
  "database-dependency-drift",
  "baseline-worker-input-drift",
])
  test(`actual root deployStack container staging: ${scenario}`, () => {
    const result = discoverContainerBarrierProof(root, scenario);
    const success = scenario === "success" || scenario === "same-digest";
    assert.equal(result.succeeded, success);
    assert.equal(result.without631Action, "update");
    assert.equal(result.containerAction, "update");
    assert.equal(result.workerInputMatches, true);
    assert.equal(
      result.applicationWrites,
      ["success", "unhealthy-serving"].includes(scenario) ? 1 : 0,
    );
    assert.equal(result.rollouts, ["success", "unhealthy-serving"].includes(scenario) ? 1 : 0);
    assert.equal(result.dockerCalls, 0);
    if (success) assert.equal(result.unchangedAction, "noop");
  });
