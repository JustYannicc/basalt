import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { refusesAsNotServing } from "./runtime-slots/forced-restart.ts";

test("only a runtime that isn't serving goes back to recovery on unfence", () => {
  // The runtime refused as one that isn't serving: recovery restarts or proves it.
  for (const reason of ["unhealthy", "identity", "uncertain"] as const)
    assert.equal(refusesAsNotServing(new SlotRefused(reason)), true, reason);
  // A controller-side refusal or a defect stays the operator's error, and the fence holds.
  for (const reason of ["policy", "selection", "draining"] as const)
    assert.equal(refusesAsNotServing(new SlotRefused(reason)), false, reason);
  assert.equal(refusesAsNotServing(new TypeError("a defect")), false);
});
