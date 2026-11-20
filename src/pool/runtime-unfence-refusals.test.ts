import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { proofRefusedByRuntime } from "./runtime-slots/controller.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";

test("only a runtime that isn't serving goes back to recovery on unfence", () => {
  // The runtime refused as one that isn't serving: recovery restarts or proves it.
  for (const reason of ["unhealthy", "identity", "uncertain"] as const)
    assert.equal(proofRefusedByRuntime(new SlotRefused(reason)), true, reason);
  // A controller-side refusal or a defect stays the operator's error, and the fence holds.
  for (const reason of ["policy", "selection", "draining"] as const)
    assert.equal(proofRefusedByRuntime(new SlotRefused(reason)), false, reason);
  assert.equal(proofRefusedByRuntime(new PoolRuntimeUnhealthy()), true, "an unhealthy answer");
  assert.equal(proofRefusedByRuntime(new DOMException("late", "TimeoutError")), true, "no answer");
  for (const defect of [new TypeError("a defect"), new Error("a defect"), "a string"])
    assert.equal(proofRefusedByRuntime(defect), false, String(defect));
});
