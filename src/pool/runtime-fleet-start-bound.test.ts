import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { startingBoundMs, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";
import type { SlotTarget } from "./runtime-slots/contract.ts";

/**
 * A real fleet cell under one controller, on a clock the test moves; the cell's own endpoint and
 * provider run in real time, so only the ledger's bound is fast-forwarded. Growth's first draw is
 * the fixture's slot, later draws fresh slots whose stand-in cell never starts.
 */
async function boundedStart(
  context: TestContext,
  options: { maximum?: number; demand?: number; reserve?: boolean } = {},
) {
  const info = context.mock.method(console, "info", () => {});
  const warn = context.mock.method(console, "warn", () => {});
  context.mock.method(console, "error", () => {});
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  let now = Date.now();
  const maximum = options.maximum ?? 4;
  const state = new RuntimeFleetState(f.storage, maximum, () => now);
  const pending: Promise<unknown>[] = [];
  let drawn = 0;
  const fleet = new RuntimeFleet({
    state,
    target: async () =>
      drawn++ === 0
        ? f.target
        : {
            ...f.target,
            slotId: `slot-${drawn}`,
            instanceId: `instance-${drawn}`,
            homePeerOrdinal: 1 + drawn,
          },
    cell: (target: SlotTarget) =>
      target.slotId === f.target.slotId
        ? f.cell
        : ({
            start: async () => {
              throw new Error("synthetic stand-in never starts");
            },
            observe: async () => undefined,
          } as unknown as FleetCell),
    legacyActive: async () => 0,
    currentRequests: () => options.demand ?? 0,
    targetActive: 1,
    idleMilliseconds: 60_000,
    maximum,
    defer: (work) => {
      pending.push(work);
    },
    wrap: f.wrap,
    now: () => now,
  });
  if (options.reserve !== false) {
    drawn = 1;
    await state.reserve(f.target);
  }
  const pass = async () => {
    now += upkeepCadenceMs;
    await fleet.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return state.inspect();
  };
  const named = (calls: typeof info.mock.calls, line: string) =>
    calls.filter((call) => call.arguments[0] === line).map((call) => call.arguments[1]);
  return {
    f,
    state,
    pass,
    advance: (ms: number) => {
      now += ms;
    },
    /** Moves the ledger's clock to just before the start bound of a row reserved at the start. */
    toBound: () => {
      now += startingBoundMs - 2 * upkeepCadenceMs;
    },
    quarantines: () => named(warn.mock.calls, "POOL_FLEET_QUARANTINE"),
    unsent: () => named(info.mock.calls, "POOL_FLEET_START_UNSENT"),
  };
}

const neverStarted = (slotId: string) => ({
  slotId,
  end: null,
  left: "retired",
  reason: null,
  failure: { path: "start", rule: "unsent", reads: [] },
});

test("a start the provider's rollout held to its bound, sending nothing, leaves as never started, not quarantined", async (context) => {
  const b = await boundedStart(context);
  // While Cloudflare rolls out an image the launch read is refused, before anything is sent.
  b.f.rollout(true);
  let [row] = await b.pass();
  assert.equal(row?.phase, "uncertain");
  // Upkeep retries the same slot, refused the same way, until the start bound.
  b.toBound();
  [row] = await b.pass();
  assert.equal(row?.phase, "uncertain", "it left before its bound");
  assert.deepEqual(await b.pass(), [], "past its bound the unsent start still holds a place");
  assert.equal(b.f.calls.start, 0, "a compute start was sent");
  assert.equal(b.f.ctx.container.running, false);
  assert.deepEqual(await b.state.recentEnds(), [neverStarted(b.f.target.slotId)]);
  assert.deepEqual(b.quarantines(), [], "a never-sent start was quarantined");
  const [line] = b.unsent() as { slot?: string; heldMs?: number }[];
  assert.equal(line?.slot, b.f.target.slotId);
  assert.ok((line?.heldMs ?? 0) >= startingBoundMs);
});

test("a reserved row its pass never dispatched leaves as never started at its bound", async (context) => {
  const b = await boundedStart(context);
  b.advance(startingBoundMs);
  assert.deepEqual(await b.pass(), []);
  assert.equal(b.f.calls.start, 0);
  assert.deepEqual(await b.state.recentEnds(), [neverStarted(b.f.target.slotId)]);
});

test("a full fleet whose unsent start leaves grows into the freed place", async (context) => {
  const b = await boundedStart(context, { maximum: 1, demand: 1, reserve: false });
  b.f.rollout(true);
  // Growth reserves the fixture's slot; the rollout refuses it, so it waits uncertain.
  let rows = await b.pass();
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase]),
    [[b.f.target.slotId, "uncertain"]],
  );
  // A few passes while full, so growth holds itself at capacity.
  for (let index = 0; index < 3; index++) rows = await b.pass();
  b.toBound();
  await b.pass();
  rows = await b.pass();
  assert.ok(!rows.some((row) => row.target.slotId === b.f.target.slotId), "the unsent start left");
  assert.equal(rows.length, 1, "growth didn't draw into the freed place");
});

test("a held start whose cell can't fence its endpoint keeps the start_unproven quarantine", async (context) => {
  const b = await boundedStart(context);
  b.f.rollout(true);
  await b.pass();
  // The fence is refused, so nothing proves no later start can run.
  b.f.transport.refuse["/abandon-start"] = "uncertain";
  b.toBound();
  await b.pass();
  const [row] = await b.pass();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "start_unproven");
  assert.deepEqual(b.unsent(), []);
});

test("a start still under way in its cell at the bound keeps the start_unproven quarantine", async (context) => {
  const b = await boundedStart(context);
  b.f.rollout(true);
  await b.pass();
  b.f.rollout(false);
  // The cell's own start is held at the endpoint's admission when the bound is reached.
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const original = b.f.stub.fetch;
  b.f.stub.fetch = async (request: Request) => {
    if (new URL(request.url).pathname === "/admit") {
      reached();
      await opened;
    }
    return original(request);
  };
  const started = b.f.cell.start(b.f.target).catch(() => undefined);
  await arrived;
  b.advance(startingBoundMs);
  const [row] = await b.pass();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "start_unproven");
  open();
  await started;
});

test("a start that was sent and never proven still quarantines at its bound", async (context) => {
  const b = await boundedStart(context);
  // Admitted, so its first-start intent is written before the endpoint refuses the compute start.
  b.f.transport.refuse["/start"] = "uncertain";
  let [row] = await b.pass();
  assert.equal(row?.phase, "uncertain");
  b.toBound();
  await b.pass();
  [row] = await b.pass();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "start_unproven");
  assert.deepEqual(b.unsent(), [], "a sent start left as never started");
});
