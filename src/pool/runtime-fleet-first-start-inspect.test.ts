import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";

const unready = () => new Response(null, { status: 503 });
const quiet = (context: TestContext) => {
  context.mock.method(console, "warn", () => {});
  context.mock.method(console, "info", () => {});
};

/** A real fleet cell and its endpoint under the fleet controller the inspect reads through. */
async function inspected(context: TestContext) {
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  const state = new RuntimeFleetState(f.storage, 1, () => Date.now());
  const fleet = new RuntimeFleet({
    state,
    target: async () => f.target,
    cell: () => f.cell,
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 1,
    idleMilliseconds: 60 * 60_000,
    maximum: 1,
    defer: () => {},
    wrap: f.wrap,
    now: () => Date.now(),
  });
  const store = new RuntimeWitnessStore(f.ctx.storage, f.env.POOL_DEPLOYMENT_KEY!);
  const row = async () =>
    (await state.inspect()).find((value) => value.target.slotId === f.target.slotId)!;
  return {
    f,
    state,
    store,
    /** The fleet inspect's read of the cell's row. */
    firstStart: async () => fleet.firstStart(await row()),
    /** Its start bound fired before it was proven: quarantined without an identity. */
    async quarantine() {
      const held = await row();
      assert.equal(await state.exceed(f.target, held.phase, held.phaseAt!, "start_unproven"), true);
      assert.equal((await row()).identity, undefined);
    },
  };
}
type Inspected = Awaited<ReturnType<typeof inspected>>;

/** Readiness answers `good` reads, then lapses: the start fails at whatever read comes next. */
async function failedStart(s: Inspected, good: number) {
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  let reads = 0;
  s.f.hooks.health = async () => (++reads <= good ? undefined : unready());
  await assert.rejects(s.f.cell.start(s.f.target));
  assert.equal(await s.f.cell.selected(), undefined, "it activated");
}

test("the inspect reads a quarantined start that attested, with nothing selected, as attested, and the read fences, stops, starts and renews nothing", async (context) => {
  quiet(context);
  const s = await inspected(context);
  await failedStart(s, 4);
  assert.ok((await s.store.retained(s.f.target.slotId))?.attestation, "it never attested");
  await s.quarantine();
  const before = { ...s.f.calls, signals: [...s.f.calls.signals] };
  assert.equal(await s.firstStart(), "attested");
  assert.equal(await s.firstStart(), "attested");
  assert.equal(await s.store.abandoned(s.f.target.slotId), false, "the read fenced the slot");
  assert.deepEqual(s.f.calls.signals, before.signals, "the read signalled the container");
  assert.equal(s.f.calls.destroy, before.destroy);
  assert.equal(s.f.calls.start, before.start, "the read started it");
  assert.equal(s.f.calls.keepAlive, before.keepAlive, "the read renewed it");
  assert.equal(s.f.ctx.container.running, true);
  // Every quarantined pass fences it, and the inspect still reads it behind the fence.
  await s.f.replacedCell().abandon(s.f.target);
  assert.equal(await s.store.abandoned(s.f.target.slotId), true);
  assert.equal(await s.firstStart(), "attested", "a fenced slot hid its attestation");
});

test("the inspect reads a quarantined start that neither attested nor activated as neither", async (context) => {
  quiet(context);
  const s = await inspected(context);
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  s.f.transport.refuse["/attest"] = "uncertain";
  await assert.rejects(s.f.cell.start(s.f.target));
  assert.equal(s.f.ctx.container.running, true, "the container booted");
  await s.quarantine();
  assert.equal(await s.firstStart(), "neither");
  // A start whose readiness lapsed before it could attest reads the same.
  const lapsed = await inspected(context);
  await failedStart(lapsed, 2);
  await lapsed.quarantine();
  assert.equal(await lapsed.firstStart(), "neither");
});

test("the inspect reads a quarantined start whose selection committed as activated", async (context) => {
  quiet(context);
  const s = await inspected(context);
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  // It activates, but its bound fires before the ledger admits it.
  const identity = await s.f.cell.start(s.f.target);
  await s.quarantine();
  assert.equal((await s.f.cell.selected())?.bootId, identity.bootId);
  assert.equal(await s.firstStart(), "activated");
  await s.f.replacedCell().abandon(s.f.target);
  assert.equal(await s.firstStart(), "activated", "a fresh cell read it otherwise");
});

test("the inspect reads no first start for a row with an identity or one still starting, and null where the cell can't say", async (context) => {
  quiet(context);
  const s = await inspected(context);
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  assert.equal(await s.firstStart(), undefined, "a start still in its bound");
  s.f.transport.refuse["/attest"] = "uncertain";
  await assert.rejects(s.f.cell.start(s.f.target));
  await s.quarantine();
  // An endpoint that can't answer the read, as one on older code answers an action it lacks.
  s.f.transport.refuse["/attestation"] = "uncertain";
  assert.equal(await s.firstStart(), null);
  delete s.f.transport.refuse["/attestation"];
  assert.equal(await s.firstStart(), "neither");
  // A row with an identity was admitted, so how far its first start got is no longer in question.
  const admitted = await inspected(context);
  await admitted.state.reserve(admitted.f.target);
  await admitted.state.dispatch(admitted.f.target);
  const identity = await admitted.f.cell.start(admitted.f.target);
  await admitted.state.ready(identity);
  await admitted.state.quarantine(identity, "runtime_failed");
  assert.equal(await admitted.firstStart(), undefined);
});
