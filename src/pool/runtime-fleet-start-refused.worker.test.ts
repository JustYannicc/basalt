import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { readFailure } from "./runtime-fleet/failure-record.ts";

interface Inspected {
  resources: {
    phase: string;
    reason?: string;
    target: { slotId: string; instanceId: string };
    failure?: unknown;
  }[];
  recentEnds?: { slotId: string }[];
}

// A runtime object still on the Worker version before a deploy runs that version's controller code.
const olderCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };

test("a first start refused by a runtime object on older code leaves unstarted at once with why, no quarantine, and a fresh slot serves on the next pass", async (context) => {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  const warn = context.mock.method(console, "warn", () => {});
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  assert.notDeepEqual(olderCode, runtimeFixtureCode);
  let olderSlot: string | undefined;
  f.onRuntimeCode((target) => {
    olderSlot ??= target.slotId;
    return target.slotId === olderSlot ? olderCode : undefined;
  });
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "start-refused",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const inspect = async () => (await f.send("fleet-inspect")) as Inspected;
  // The call that wants a cell: the root serves it while growth's first start is refused.
  const first = await f.model();
  assert.equal(first.status, 200);
  await first.body?.cancel();
  await f.settle();
  const refused = await inspect();
  assert.ok(olderSlot);
  assert.deepEqual(refused.resources, [], "the refused start still holds a place");
  // Its end says why, under a rule that never counts against a runtime.
  const end = refused.recentEnds?.find((entry) => entry.slotId === olderSlot) as
    | { left?: string; reason?: unknown; failure?: unknown }
    | undefined;
  assert.equal(end?.left, "retired");
  assert.equal(end?.reason, null);
  const failure = readFailure(end?.failure);
  assert.equal(failure?.path, "start");
  assert.equal(failure?.rule, "deployment");
  assert.equal(failure?.reads[0]?.step, "endpoint_route");
  assert.equal(failure?.reads[0]?.cause, "slot_identity");
  assert.deepEqual(
    warn.mock.calls
      .filter((call) => call.arguments[0] === "POOL_FLEET_GROWTH_REFUSED")
      .map((call) => call.arguments[1]),
    [{ step: "endpoint_route", reason: "slot_identity", cause: null, error: "SlotRefused" }],
  );
  assert.equal(
    warn.mock.calls.filter((call) => call.arguments[0] === "POOL_FLEET_QUARANTINE").length,
    0,
    "no quarantine",
  );
  // The next pass draws a fresh slot.
  now += 2_000;
  await f.upkeep();
  await f.settle();
  const rows = await f.resourcesWhen((value) => value.some((row) => row.phase === "ready"));
  const fresh = rows.find((row) => row.phase === "ready")!;
  assert.notEqual(fresh.target.slotId, olderSlot);
  const served: string[] = [];
  f.onModel(async (instance) => {
    served.push(instance.target.instanceId);
    return new Response("served");
  });
  const call = await f.model();
  assert.equal(call.status, 200);
  await call.body?.cancel();
  assert.deepEqual(served, [fresh.target.instanceId]);
});
