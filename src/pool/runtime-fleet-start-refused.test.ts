import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { deferred, SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { FleetAdmission } from "./runtime-fleet/admission.ts";
import { RuntimeFleetState, type FleetRow } from "./runtime-fleet/state.ts";
import { readFailure } from "./runtime-fleet/failure-record.ts";
import { SlotFirstStart } from "./runtime-slots/first-start.ts";
import type { SlotIdentity, SlotTarget } from "./runtime-slots/contract.ts";

const target = (slot: number, applicationVersion = "1"): SlotTarget => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: `slot-${slot}`,
  applicationId: "blue",
  applicationVersion,
  instanceId: `instance-${slot}`,
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "image",
  homePeerOrdinal: slot,
});
const retired = (slot: number) => ({
  slotId: `slot-${slot}`,
  end: null,
  left: "retired",
  reason: null,
});

test("a cancelled reservation and each start a new generation retires keep a recent end", async () => {
  const memory = new SlotMemory();
  const state = new RuntimeFleetState(memory, 4);
  await state.reserve(target(1));
  await state.cancelReserved(target(1));
  assert.deepEqual(await state.recentEnds(), [retired(1)]);
  await state.reserve(target(2));
  await state.reserve(target(3));
  await state.dispatch(target(3));
  await memory.transaction((transaction) => state.promoteGeneration(target(9, "2"), transaction));
  assert.deepEqual(await state.inspect(), []);
  assert.deepEqual(await state.recentEnds(), [retired(3), retired(2), retired(1)]);
});

/** A real fleet cell under one controller with its row reserved; a pass runs upkeep and growth. */
async function startingCell(context: TestContext, previous?: SlotIdentity) {
  for (const method of ["info", "warn", "error"] as const)
    context.mock.method(console, method, () => {});
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  const state = new RuntimeFleetState(f.storage, 4);
  const pending: Promise<unknown>[] = [];
  const fleet = new RuntimeFleet({
    state,
    target: async () => f.target,
    cell: () => f.cell,
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 1,
    idleMilliseconds: 60_000,
    maximum: 4,
    defer: (work) => {
      pending.push(work);
    },
    wrap: f.wrap,
    now: Date.now,
  });
  await state.reserve(f.target, undefined, previous ? { previous } : {});
  const pass = async () => {
    await fleet.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return state.inspect();
  };
  return { f, state, fleet, pass };
}

test("a start still under way, or one whose first-start intent was written, counts as sent", async (context) => {
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  const held = deferred();
  const envelope = FleetAdmission.prototype.envelope;
  context.mock.method(
    FleetAdmission.prototype,
    "envelope",
    async function (this: FleetAdmission, ...args: Parameters<FleetAdmission["envelope"]>) {
      await held.promise;
      return envelope.apply(this, args);
    },
  );
  const starting = f.cell.start(f.target);
  assert.equal(await f.cell.unsent(), false, "a start that may yet send counted as unsent");
  held.resolve();
  await starting;
  assert.equal(await f.cell.unsent(), false, "a written intent counted as unsent");
});

test("a start the endpoint refused after its first-start intent was written still goes uncertain", async (context) => {
  const { f, pass } = await startingCell(context);
  // Admitted, so the intent is written before the endpoint refuses the compute start itself.
  f.transport.refuse["/start"] = "uncertain";
  let [row] = await pass();
  assert.equal(row?.phase, "uncertain");
  assert.equal(row?.failure, undefined);
  // Its observation fails too, and the row stays observed until its bound.
  [row] = await pass();
  assert.equal(row?.phase, "uncertain");
});

test("a planned replacement's start the endpoint refused stays uncertain, since its record follows that row", async (context) => {
  const { f, pass } = await startingCell(context, { ...target(9), bootId: crypto.randomUUID() });
  f.transport.refuse["/admit"] = "identity";
  const [row] = await pass();
  assert.equal(row?.phase, "uncertain", "a planned replacement's row left before its record moved");
  assert.equal(row?.failure, undefined);
});

test("once a start is given up as unsent, a pass that read its row earlier sends nothing, and the row still leaves", async (context) => {
  const { f, state, fleet, pass } = await startingCell(context);
  f.transport.refuse["/admit"] = "identity";
  // Another pass reads the row as warming while growth's start is under way.
  let earlier: FleetRow | undefined;
  const dispatch = state.dispatch.bind(state);
  context.mock.method(state, "dispatch", async (value: SlotTarget) => {
    await dispatch(value);
    earlier = (await state.inspect()).find((row) => row.target.slotId === value.slotId);
  });
  // Both steps run inside one controller, interleaved as their awaits allow.
  const steps = fleet as unknown as {
    start(target: SlotTarget): Promise<void>;
    upkeepRow(row: FleetRow, rows: readonly FleetRow[]): Promise<void>;
  };
  await assert.rejects(steps.start(f.target));
  assert.equal((await state.inspect())[0]?.phase, "quarantined");
  assert.ok(earlier);
  assert.equal(earlier.phase, "warming");
  // The object admits now: it switched to this code, or its first answer was a passing defect.
  delete f.transport.refuse["/admit"];
  await assert.rejects(steps.upkeepRow(earlier, [earlier]));
  assert.equal(f.calls.start, 0, "a start given up as unsent was sent anyway");
  assert.equal(f.ctx.container.running, false);
  assert.deepEqual(await pass(), []);
});

test("a demand replacement refused before any send gives back the replacement it reserved", async () => {
  const state = new RuntimeFleetState(new SlotMemory(), 4);
  const identity = { ...target(1), bootId: crypto.randomUUID() };
  await state.reserve(target(1));
  await state.dispatch(target(1));
  await state.ready(identity);
  await state.quarantine(identity);
  await state.reserveReplacement(target(2));
  assert.equal(await state.replacements(), 0);
  await state.dispatch(target(2));
  assert.equal(
    await state.startRefused(target(2), { path: "start", rule: "evidence", reads: [] }),
    true,
  );
  await state.reclaimUnstarted(target(2));
  assert.equal(await state.replacements(), 1, "the dead cell's replacement was lost");
  assert.deepEqual(
    (await state.inspect()).map((row) => row.target.slotId),
    [target(1).slotId],
  );
});

test("an unreadable first-start intent keeps a refused start uncertain, and its retry, refused once readable, leaves at once", async (context) => {
  const { f, state, pass } = await startingCell(context);
  // The endpoint refuses admission, the step before the intent is written.
  f.transport.refuse["/admit"] = "identity";
  context.mock.method(
    SlotFirstStart.prototype,
    "inspect",
    async () => {
      throw new Error("synthetic storage read failure");
    },
    { times: 1 },
  );
  let [row] = await pass();
  assert.equal(row?.phase, "uncertain", "an unreadable intent counted as proof nothing was sent");
  // The intent reads again: the observation's retried start is refused before any send.
  [row] = await pass();
  assert.equal(f.calls.start, 0);
  assert.ok(row);
  assert.equal(row.phase, "quarantined");
  assert.equal(row.reason, "start_unproven");
  const failure = readFailure(row.failure);
  assert.equal(failure?.path, "start");
  assert.equal(failure?.rule, "evidence");
  assert.equal(failure?.reads[0]?.step, "endpoint_route");
  assert.equal(failure?.reads[0]?.cause, "slot_identity");
  // The fence and the absent intent free the place on the next pass, and the leave is kept.
  assert.deepEqual(await pass(), []);
  assert.deepEqual(await state.recentEnds(), [
    {
      slotId: f.target.slotId,
      end: null,
      left: "quarantined",
      reason: "start_unproven",
      failure: row.failure,
    },
  ]);
});
