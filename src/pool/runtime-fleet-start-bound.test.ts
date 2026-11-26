import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { startingBoundMs, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";

/**
 * A real fleet cell under one controller, its row reserved, on a clock the test moves; the cell's
 * own endpoint and provider run in real time, so only the ledger's bound is fast-forwarded.
 */
async function boundedStart(context: TestContext) {
  const info = context.mock.method(console, "info", () => {});
  const warn = context.mock.method(console, "warn", () => {});
  context.mock.method(console, "error", () => {});
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  let now = Date.now();
  const state = new RuntimeFleetState(f.storage, 4, () => now);
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
    now: () => now,
  });
  await state.reserve(f.target);
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
    /** Moves the ledger's clock to just before the start bound of a row reserved at the start. */
    toBound: () => {
      now += startingBoundMs - 2 * upkeepCadenceMs;
    },
    quarantines: () => named(warn.mock.calls, "POOL_FLEET_QUARANTINE"),
    unsent: () => named(info.mock.calls, "POOL_FLEET_START_UNSENT"),
  };
}

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
  assert.deepEqual(await b.state.recentEnds(), [
    {
      slotId: b.f.target.slotId,
      end: null,
      left: "retired",
      reason: null,
      failure: { path: "start", rule: "unsent", reads: [] },
    },
  ]);
  assert.deepEqual(b.quarantines(), [], "a never-sent start was quarantined");
  const [line] = b.unsent() as { slot?: string; heldMs?: number }[];
  assert.equal(line?.slot, b.f.target.slotId);
  assert.ok((line?.heldMs ?? 0) >= startingBoundMs);
});

test("a held start whose cell can't fence its endpoint keeps the start_unproven quarantine", async (context) => {
  const b = await boundedStart(context);
  b.f.rollout(true);
  await b.pass();
  // The fence never answers, so nothing proves no later start can run.
  b.f.transport.refuse["/abandon-start"] = "uncertain";
  b.toBound();
  await b.pass();
  const [row] = await b.pass();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "start_unproven");
  assert.deepEqual(b.unsent(), []);
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
