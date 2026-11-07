import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverContainerBarrierProof } from "../architecture/native-stack.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const scenario of [
  "success",
  "unhealthy-serving",
  "same-digest",
  "same-digest-unhealthy",
  "dependency-only",
  "new-runtime-ready",
  "new-ready-late-rejection",
  "late-worker-rejection",
  "missing-startup",
  "over-ceiling",
  "container-drift",
  "source-drift",
  "native-state-drift",
  "database-dependency-drift",
  "baseline-worker-input-drift",
])
  test(`actual root deployStack container staging: ${scenario}`, (context) => {
    const result = discoverContainerBarrierProof(root, scenario);
    const success = ["success", "same-digest", "dependency-only", "new-runtime-ready"].includes(
      scenario,
    );
    assert.equal(result.succeeded, success);
    assert.equal(result.without631Action, "update");
    assert.equal(result.containerAction, "update");
    assert.equal(result.workerInputMatches, true);
    assert.equal(
      result.applicationWrites,
      ["success", "unhealthy-serving", "new-runtime-ready"].includes(scenario) ? 1 : 0,
    );
    assert.equal(
      result.rollouts,
      ["success", "unhealthy-serving", "new-runtime-ready"].includes(scenario) ? 1 : 0,
    );
    assert.equal(result.dockerCalls, 0);
    if (success) assert.equal(result.unchangedAction, "noop");
    assert.deepEqual(result.containerDependencies, ["PoolWorker"]);
    assert.ok(result.readinessDependencies.includes("PoolWorker"));
    assert.ok(result.readinessDependencies.includes("PoolContainer"));
    if (["success", "dependency-only", "new-runtime-ready"].includes(scenario))
      context.diagnostic(
        JSON.stringify({
          scenario,
          containerDependencies: result.containerDependencies,
          readinessDependencies: result.readinessDependencies,
          planReasons: result.planReasons,
        }),
      );
    assert.ok(!result.containerDependencies.includes("PoolBackendBudgetRuntimeReady"));
    if (scenario === "dependency-only") {
      assert.equal(result.containerBindingUnresolved, true);
      assert.ok(
        result.planReasons.some((why) => why.includes("PoolWorker") && why.includes("unknown")),
      );
      assert.ok(result.planReasons.some((why) => why.includes("image build input hash unchanged")));
    }
    if (scenario === "success")
      assert.ok(result.planReasons.some((why) => why.includes("image build input hash changed")));
  });
