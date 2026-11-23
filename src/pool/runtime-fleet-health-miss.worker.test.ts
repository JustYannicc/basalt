import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { readFailure, readSuspect } from "./runtime-fleet/failure-record.ts";

interface Inspected {
  resources: { phase: string; target: { slotId: string }; suspect?: unknown; failure?: unknown }[];
  recentEnds?: { slotId: string; left?: string; reason?: string | null; failure?: unknown }[];
}

/** A ready cell beside the primary, whose readiness answers the test can turn into a 503. */
async function readyCell(context: TestContext) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  context.mock.method(console, "error", () => {});
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "health-miss",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const response = await f.model();
  assert.equal(response.status, 200);
  await response.body?.cancel();
  await f.settle();
  const [row] = await f.resourcesWhen((rows) => rows.some((value) => value.phase === "ready"));
  assert.ok(row);
  const cell = f.instances.get(row.target.instanceId)!.fixture;
  const healthy = cell.hooks.health;
  const served: string[] = [];
  f.onModel(async (instance) => {
    served.push(instance.target.instanceId);
    return new Response("served");
  });
  const inspect = async () => (await f.send("fleet-inspect")) as Inspected;
  const pass = async () => {
    await f.upkeep();
    await f.settle();
  };
  // Settle the membership pass first, so the passes the test measures are the fleet's own reads.
  await pass();
  return {
    f,
    slotId: row.target.slotId,
    inspect,
    pass,
    served,
    instanceId: row.target.instanceId,
    advance: (ms: number) => {
      now += ms;
    },
    refuse: () => {
      cell.hooks.health = async () => new Response(null, { status: 503 });
    },
    /** Killed under the fleet: the container's own monitor sees the exit. */
    kill: () => cell.ctx.container.signal(9),
    /** The monitor settles with no exit while the process runs on, so `running` reads false (#1814). */
    loseMonitor: () => cell.loseMonitor(new Error("Network connection lost.")),
    /** `running` reads false with the monitor still pending: nothing recorded. */
    stopReading: () => cell.crash(),
    answer: () => {
      cell.hooks.health = healthy;
    },
  };
}

test("a cell whose readiness refuses once is fenced, read again and serves on", async (context) => {
  const c = await readyCell(context);
  c.refuse();
  await c.pass();
  const suspect = (await c.inspect()).resources.find((row) => row.target.slotId === c.slotId);
  assert.equal(suspect?.phase, "ready", "one refused readiness read quarantined the cell");
  assert.ok(readSuspect(suspect?.suspect), "the suspect cell is not readable in the fleet inspect");
  // A model call during the miss goes anywhere but the fenced cell.
  const response = await c.f.model();
  assert.equal(response.status, 200);
  await response.body?.cancel();
  assert.ok(c.served.length > 0);
  assert.ok(!c.served.includes(c.instanceId), "a call reached the fenced cell");
  // The next pass, 2 s on: a good read taken at the miss's own instant lifts nothing.
  c.advance(2_000);
  c.answer();
  await c.pass();
  const after = await c.inspect();
  const row = after.resources.find((value) => value.target.slotId === c.slotId);
  assert.equal(row?.phase, "ready");
  assert.equal(row?.suspect, undefined);
  assert.deepEqual(after.recentEnds ?? [], []);
});

test("a cell whose readiness refuses twice, 6 s apart, is quarantined with both reads, and they stay readable after it leaves", async (context) => {
  const c = await readyCell(context);
  c.refuse();
  await c.pass();
  // Two failed reads count only 6 s apart.
  c.advance(6_000);
  await c.pass();
  const quarantined = (await c.inspect()).resources.find((row) => row.target.slotId === c.slotId);
  assert.equal(quarantined?.phase, "quarantined");
  const failure = readFailure(quarantined?.failure);
  assert.equal(failure?.path, "health");
  assert.equal(failure?.rule, "failed_twice");
  assert.equal(failure?.reads.length, 2);
  // The cell still runs: the reclaim drains and stops it, as on the first life after the release.
  c.answer();
  for (let pass = 0; pass < 3; pass++) await c.pass();
  const left = (await c.inspect()).recentEnds?.find((entry) => entry.slotId === c.slotId);
  assert.equal(left?.left, "quarantined");
  assert.equal(left?.reason, "runtime_failed");
  assert.deepEqual(readFailure(left?.failure), failure);
});

test("a cell killed under the fleet is quarantined on the first read, from the exit its monitor recorded", async (context) => {
  const c = await readyCell(context);
  c.kill();
  await c.f.settle();
  await c.pass();
  // One pass quarantines it. The fixture lists the stopped instance at once, so the reclaim may also
  // finish in that pass; the provider lists it inactive only about 10 s later.
  const inspected = await c.inspect();
  const row = inspected.resources.find((value) => value.target.slotId === c.slotId);
  const left = inspected.recentEnds?.find((entry) => entry.slotId === c.slotId);
  assert.ok(row?.phase === "quarantined" || left?.left === "quarantined", "a recorded exit waited");
  const failure = readFailure(row?.failure ?? left?.failure);
  assert.equal(failure?.rule, "evidence");
  assert.equal(failure?.reads[0]?.ended, true);
});

for (const [name, stop] of [
  ["whose monitor settled with no exit", "loseMonitor"],
  ["whose running flag reads false with nothing recorded", "stopReading"],
] as const)
  test(`a cell ${name} is only fenced on the first read: the running flag alone never removes it`, async (context) => {
    const c = await readyCell(context);
    c[stop]();
    await c.f.settle();
    await c.pass();
    const inspected = await c.inspect();
    const row = inspected.resources.find((value) => value.target.slotId === c.slotId);
    assert.equal(row?.phase, "ready", "a stopped flag alone quarantined the cell");
    const suspect = readSuspect(row?.suspect);
    assert.ok(suspect, "the cell was not fenced");
    assert.notEqual(suspect.reads[0]?.ended, true);
    assert.equal(
      inspected.recentEnds?.find((entry) => entry.slotId === c.slotId),
      undefined,
    );
  });
