import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { fleetRouting } from "./runtime-fleet/production.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import {
  countStillMs,
  drainingBoundMs,
  fleetWakeUp,
  quarantineReportMs,
  retiringBoundMs,
  startingBoundMs,
  upkeepCadenceMs,
} from "./runtime-fleet/phase-bounds.ts";
import { modelUseAssertionTtlMs } from "./membership-contract.ts";

const deadline = async (): Promise<never> => {
  throw new Error("The pool did not become ready within the startup budget");
};
const unhealthy = async (): Promise<never> => {
  throw new Error("The pool runtime is temporarily unhealthy");
};
const quiet = (context: { mock: { method: typeof import("node:test").mock.method } }) => {
  context.mock.method(console, "info", () => {});
  return context.mock.method(console, "warn", () => {});
};
// A held model socket counts as one stream until its use assertion runs out; no stream lives longer.
const longestStreamMs = modelUseAssertionTtlMs + 5 * 60_000;

test("a slow but healthy start that answers inside its bound is admitted, never quarantined", async (context) => {
  quiet(context);
  const f = quietFleet();
  let answersAt = Number.POSITIVE_INFINITY;
  const slot = await f.reserve({
    start: async () => {
      answersAt = f.now() + startingBoundMs - 10_000;
      return deadline();
    },
    observe: async (target) =>
      f.now() >= answersAt ? { ...target, bootId: "boot-slow" } : unhealthy(),
  });
  // Past the bound, and short of the admitted cell's own idle bound.
  const rows = await f.quiet(startingBoundMs + 20_000);
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase, row.identity?.bootId]),
    [[slot.slotId, "ready", "boot-slow"]],
  );
});

test("a start whose own call takes most of its bound still becomes ready", async (context) => {
  quiet(context);
  const f = quietFleet();
  const slot = await f.reserve({
    start: async (target) => {
      f.advance(startingBoundMs - 5_000);
      return { ...target, bootId: "boot-long" };
    },
  });
  const rows = await f.quiet(10_000);
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase]),
    [[slot.slotId, "ready"]],
  );
});

test("a start whose instance may still run holds its place, says so hourly, and never frees it", async (context) => {
  const warn = quiet(context);
  const f = quietFleet();
  const stuck = await f.reserve({
    start: deadline,
    observe: unhealthy,
    abandon: async () => false,
  });
  const rows = await f.quiet(150 * 60_000);
  const row = rows.find((value) => value.target.slotId === stuck.slotId);
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "start_unproven");
  assert.equal(await f.state.physicalCount(), 1, "the place stays held without proof");
  const lines = warn.mock.calls
    .filter(({ arguments: [line] }) => line === "POOL_FLEET_QUARANTINE")
    .map(({ arguments: [, fields] }) => fields as { event: string; reason: string });
  assert.deepEqual(
    lines.map(({ event, reason }) => [event, reason]),
    [
      ["entered", "start_unproven"],
      ["held", "start_unproven"],
      ["held", "start_unproven"],
    ],
  );
});

test("a held place never stops growth into a free one", async (context) => {
  quiet(context);
  const f = quietFleet();
  const stuck = await f.reserve({
    start: deadline,
    observe: unhealthy,
    abandon: async () => false,
  });
  await f.quiet(startingBoundMs + 10_000);
  // Past the last pass's own 100 ms growth check.
  f.advance(1_000);
  await (await f.call()).text();
  await f.settle();
  const rows = await f.state.inspect();
  assert.deepEqual(
    rows.map((row) => [row.target.slotId === stuck.slotId, row.phase]),
    [
      [true, "quarantined"],
      [false, "ready"],
    ],
  );
});

test("a retiring row whose absence is never proven keeps its place in quarantine", async (context) => {
  quiet(context);
  const f = quietFleet({ idleMilliseconds: 1_000 });
  await f.add({ retired: async () => false });
  const rows = await f.quiet(60 * 60_000);
  assert.deepEqual(
    rows.map((row) => [row.phase, row.reason]),
    [["quarantined", "absence_unproven"]],
  );
  assert.equal(await f.state.physicalCount(), 1);
});

test("a ready cell carrying one stream of the longest allowed length stays ready and counted", async (context) => {
  quiet(context);
  const f = quietFleet();
  const cell = await f.add({ drain: async () => ({ active: 1, known: true }) });
  const held = await f.call();
  const rows = await f.quiet(longestStreamMs + 10 * 60_000, 20_000);
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase, row.active]),
    [[cell.slotId, "ready", 1]],
  );
  await held.body!.cancel();
});

test("a draining cell's live stream is never counted away, and a lost release is once it ends", async (context) => {
  quiet(context);
  let live = 1;
  const f = quietFleet();
  const cell = await f.add({ drain: async () => ({ active: live, known: true }) });
  await f.call();
  f.restart();
  await f.fleet.drain(cell);
  let rows = await f.quiet(longestStreamMs, 20_000);
  assert.deepEqual(
    rows.map((row) => [row.phase, row.active]),
    [["draining", 1]],
  );
  live = 0;
  rows = await f.quiet(10 * 60_000);
  assert.deepEqual(rows, []);
});

test("reconciling a lost release never drains the only serving cell while the root can't serve", async (context) => {
  quiet(context);
  const f = quietFleet({
    primary: fleetRouting.primary,
    primaryAvailable: () => false,
    legacy: unhealthy,
  });
  const cell = await f.add();
  await f.call();
  f.restart();
  const rows = await f.quiet(60 * 60_000);
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase, row.active]),
    [[cell.slotId, "ready", 0]],
  );
});

test("a row stored before phase times existed starts its bound at the next write, never in the past", async () => {
  const memory = new SlotMemory();
  let now = 5_000_000;
  const state = new RuntimeFleetState(memory, 4, () => now);
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "controller",
    slotId: "slot-old",
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: "instance-old",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: 1,
  };
  const identity = { ...target, bootId: "boot-old" };
  await memory.put("runtime-fleet-v1:resources", [
    { target, identity, phase: "retiring", active: 0, drainAcknowledged: true, lastUsedAt: 1 },
  ]);
  assert.equal((await state.inspect())[0]?.phaseAt, undefined);
  now += 1_000;
  await state.stampPhases();
  assert.equal((await state.inspect())[0]?.phaseAt, 5_001_000);
});

test("in quiet time the next fleet wake-up never comes later than the earliest bound of any row", () => {
  const idleMilliseconds = 60_000;
  const at = 10_000_000;
  type Shape = Parameters<typeof fleetWakeUp>[0][number];
  const shapes: Shape[] = [
    { phase: "reserved", active: 0, lastUsedAt: at, phaseAt: at },
    { phase: "warming", active: 0, lastUsedAt: at, phaseAt: at + 7_000 },
    { phase: "uncertain", active: 0, lastUsedAt: at, phaseAt: at + 180_000 },
    { phase: "ready", active: 0, lastUsedAt: at + 3_000, phaseAt: at },
    { phase: "ready", active: 2, lastUsedAt: at, phaseAt: at },
    { phase: "draining", active: 1, drainAcknowledged: true, lastUsedAt: at + 30_000, phaseAt: at },
    { phase: "draining", active: 1, drainAcknowledged: true, lastUsedAt: at, phaseAt: at + 90_000 },
    { phase: "draining", active: 0, drainAcknowledged: true, lastUsedAt: at, phaseAt: at },
    { phase: "retiring", active: 0, drainAcknowledged: true, lastUsedAt: at, phaseAt: at + 1_000 },
    { phase: "quarantined", active: 0, lastUsedAt: at, phaseAt: at },
  ];
  // The next instant each row needs a pass: its phase bound, idle bound, count bound or hourly report.
  const due = (row: Shape, now: number) => {
    const phaseAt = row.phaseAt!;
    const bounds: number[] = [];
    if (["reserved", "warming", "uncertain"].includes(row.phase))
      bounds.push(phaseAt + startingBoundMs);
    if (row.phase === "draining") bounds.push(phaseAt + drainingBoundMs);
    if (row.phase === "retiring") bounds.push(phaseAt + retiringBoundMs);
    if (row.phase === "quarantined")
      bounds.push(phaseAt + Math.ceil((now - phaseAt) / quarantineReportMs) * quarantineReportMs);
    if (row.phase === "ready" && row.active === 0) bounds.push(row.lastUsedAt + idleMilliseconds);
    if ((row.phase === "ready" || row.phase === "draining") && row.active > 0)
      bounds.push(row.lastUsedAt + countStillMs);
    return Math.min(...bounds.map((bound) => Math.max(bound, now)));
  };
  for (const fleet of [...shapes.map((shape) => [shape]), shapes])
    for (let now = at; now <= at + 3 * 60 * 60_000; now += 997) {
      const wake = fleetWakeUp(fleet, { enabled: true, idleMilliseconds }, now);
      const earliest = Math.min(...fleet.map((row) => due(row, now)));
      assert.ok(wake !== undefined, `${fleet.map((row) => row.phase)} never wakes the fleet`);
      assert.ok(wake > now, "a wake-up is never in the past");
      assert.ok(
        wake <= Math.max(earliest, now + upkeepCadenceMs),
        `${fleet.map((row) => row.phase)} at +${now - at} ms wakes at +${wake - at}, after its bound at +${earliest - at}`,
      );
    }
});

test("a controller replaced in the middle of a retirement retires on the observed absence without a second destroy", async (context) => {
  quiet(context);
  let absent = false;
  const f = quietFleet({ idleMilliseconds: 1_000 });
  await f.add({ retired: async () => absent });
  assert.deepEqual(
    (await f.pass()).map((row) => row.phase),
    ["draining"],
  );
  assert.deepEqual(
    (await f.pass()).map((row) => row.phase),
    ["retiring"],
  );
  assert.equal(f.calls.retires, 1);
  f.restart();
  absent = true;
  assert.deepEqual(await f.pass(), []);
  assert.equal(f.calls.retires, 1, "the replaced controller never sends a second destroy");
});

test("a failed runtime whose absence never arrives holds its place, says so hourly, and never frees it", async (context) => {
  const warn = quiet(context);
  const f = quietFleet();
  const cell = await f.add();
  await f.state.quarantine(cell);
  const rows = await f.quiet(150 * 60_000);
  const held = rows.find((row) => row.target.slotId === cell.slotId);
  assert.deepEqual([held?.phase, held?.reason], ["quarantined", "runtime_failed"]);
  assert.ok(
    !rows.some(
      (row) =>
        row.target.slotId !== cell.slotId && row.target.homePeerOrdinal === cell.homePeerOrdinal,
    ),
    "no other runtime took the held place",
  );
  const lines = warn.mock.calls
    .filter(({ arguments: [line, fields] }) => {
      const value = fields as { slot?: string } | undefined;
      return line === "POOL_FLEET_QUARANTINE" && value?.slot === cell.slotId;
    })
    .map(({ arguments: [, fields] }) => (fields as { event: string }).event);
  assert.deepEqual(lines, ["entered", "held", "held"]);
});
