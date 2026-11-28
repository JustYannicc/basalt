import assert from "node:assert/strict";
import { test } from "node:test";
import { poolRuntimeFleetFixture } from "../../scripts/pool-tests/pool-runtime-fleet-fixture.ts";
import type { ControllerCode } from "./runtime-slots/contract.ts";

const code: ControllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };

// The production fleet hands its own ledger to its cells. A cell's retire read runs before its
// retirement begins or reaches any endpoint, so a `begin` that throws shows the read passed.
test("a production cell's retire read ignores a sibling its own ledger counts, and only that one", async (context) => {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  const f = await poolRuntimeFleetFixture(code);
  const fleet = f.worker(code);
  await fleet.configure("enable", f.configuration);
  const a = f.launch(),
    b = f.launch();
  await fleet.state.reserve(a);
  await fleet.state.reserve(b);
  const identity = { ...a, bootId: "11111111-1111-1111-1111-111111111111" };
  const begun = new Error("retirement begun");
  const retire = () =>
    fleet["cell"](a).retire(identity, async () => {
      throw begun;
    });
  f.listed.set(a.instanceId, "running");
  f.listed.set(b.instanceId, "stopping");
  // B is a row of this ledger: the read passes and the retirement begins.
  await assert.rejects(retire(), (error) => error === begun);
  // An instance no row counts still holds it.
  f.listed.set("blue-stray", "stopping");
  await assert.rejects(retire(), (error: { refusal?: { reason?: string; state?: string } }) => {
    assert.deepEqual(error.refusal, { reason: "sibling_unsettled", state: "stopping" });
    return true;
  });
});
