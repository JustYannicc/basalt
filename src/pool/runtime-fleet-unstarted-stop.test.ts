import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { startingBoundMs, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";
import { forcedStopGraceMs } from "./runtime-slots/forced-restart-timing.ts";
import { runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import { RuntimeEndpoint } from "./runtime-slots/endpoint.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";
import { runtimeRequest } from "./runtime-slots/transport.ts";
import type { SlotTarget } from "./runtime-slots/contract.ts";

const unready = () => new Response(null, { status: 503 });
const gate = () => {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  return { open, opened, reached, arrived };
};

/**
 * A real fleet cell, its endpoint and its provider listing under one controller, on one clock the
 * test moves, as production reads `Date.now` for the ledger, the cell and the endpoint alike. The
 * stop's grace is spent on that clock, as for a Home that doesn't exit on SIGTERM. Growth draws the
 * fixture's slot first; later draws are stand-ins that never start.
 */
async function stuckFleet(
  context: TestContext,
  options: { demand?: number; grace?: () => Promise<void> } = {},
) {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const warn = context.mock.method(console, "warn", () => {});
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  context.mock.method(
    runtimeStopTiming,
    "stopGrace",
    options.grace ?? (async () => context.mock.timers.tick(forcedStopGraceMs)),
  );
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  const state = new RuntimeFleetState(f.storage, 1, () => Date.now());
  const pending: Promise<unknown>[] = [];
  let drawn = 0;
  const standIn = {
    start: async () => {
      throw new Error("synthetic stand-in never starts");
    },
    observe: async () => undefined,
    selected: async () => undefined,
  } as unknown as FleetCell;
  const controller = (cell: FleetCell) =>
    new RuntimeFleet({
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
      cell: (target: SlotTarget) => (target.slotId === f.target.slotId ? cell : standIn),
      legacyActive: async () => 0,
      currentRequests: () => options.demand ?? 0,
      targetActive: 1,
      idleMilliseconds: 60 * 60_000,
      maximum: 1,
      defer: (work) => {
        pending.push(work);
      },
      wrap: f.wrap,
      now: () => Date.now(),
    });
  let fleet = controller(f.cell);
  const store = new RuntimeWitnessStore(f.ctx.storage, f.env.POOL_DEPLOYMENT_KEY!);
  const row = async () =>
    (await state.inspect()).find((value) => value.target.slotId === f.target.slotId);
  return {
    f,
    state,
    row,
    /** One fleet alarm `milliseconds` later. Without `settle`, a stop under way keeps running. */
    async pass(milliseconds = upkeepCadenceMs, settle = true) {
      context.mock.timers.tick(milliseconds);
      await fleet.upkeep();
      while (pending.length) await Promise.allSettled(pending.splice(0));
      if (settle) await f.settle();
      return row();
    },
    fenced: () => store.abandoned(f.target.slotId),
    stops: () =>
      warn.mock.calls
        .filter((call) => call.arguments[0] === "POOL_RUNTIME_ABANDONED_STOP")
        .map((call) => (call.arguments[1] as { path: string }).path),
    forward: async () => {
      const response = await fleet.forward(
        new Request("http://pool/v1/responses", { method: "POST" }),
        undefined,
        async () => {
          throw new Error("synthetic: the root takes no call here");
        },
        () => {},
      );
      await response.text();
      return response.status;
    },
    /** The controller's isolate replaced: a fresh fleet controller and cell over the same storage. */
    replaceController() {
      fleet = controller(f.replacedCell());
    },
    /** The cell's runtime object replaced: a fresh endpoint over the same storage and container. */
    replaceEndpoint() {
      const endpoint = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap, {
        ownStorage: f.ctx.storage,
      });
      f.stub.fetch = (request: Request) => runtimeRequest(request, endpoint);
    },
  };
}
type Stuck = Awaited<ReturnType<typeof stuckFleet>>;

/** A start whose container booted but whose activation was refused, held past its start bound. */
async function quarantinedStart(s: Stuck) {
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  s.f.transport.refuse["/attest"] = "uncertain";
  await assert.rejects(s.f.cell.start(s.f.target));
  assert.equal(s.f.ctx.container.running, true, "the container booted");
  const row = await s.pass(startingBoundMs);
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "start_unproven");
}

test("a cell that answers ready once and then never again is stopped once, and its place grows a replacement within its bound", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  let answered = false;
  // Its container boots and answers ready once, then refuses every readiness read.
  s.f.hooks.health = async () => {
    if (answered) return unready();
    answered = true;
  };
  let row = await s.pass();
  assert.equal(row?.phase, "uncertain");
  assert.equal(s.f.calls.start, 1);
  const since = row!.phaseAt!;
  while ((row = await s.pass())?.phase === "uncertain")
    assert.ok(Date.now() - since <= startingBoundMs, "still uncertain past its bound");
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "start_unproven");
  assert.ok(row!.phaseAt! - since >= startingBoundMs, "quarantined before its bound");
  assert.deepEqual(s.f.calls.signals, [], "nothing is stopped before the quarantine");

  row = await s.pass();
  assert.deepEqual(s.f.calls.signals, [15], "one graceful stop, SIGTERM first");
  assert.equal(s.f.calls.destroy, 1, "destroyed once its grace ran out with Home still up");
  assert.deepEqual(s.stops(), ["destroy_after_grace"]);
  assert.equal(await s.fenced(), true);
  const stoppedAt = Date.now();

  // The provider lists it inactive now; its place frees only once that held for the absence bound.
  while ((row = await s.pass()) !== undefined) {
    assert.equal(row.phase, "quarantined");
    assert.ok(
      Date.now() - since <=
        startingBoundMs + forcedStopGraceMs + startingBoundMs + 3 * upkeepCadenceMs,
      "the place wasn't reclaimed within the start bound, the stop grace and the absence bound",
    );
  }
  assert.ok(Date.now() - stoppedAt >= startingBoundMs, "the absence rule was shortened");
  const rows = await s.state.inspect();
  assert.equal(rows.length, 1, "growth reserved no replacement");
  assert.notEqual(rows[0]!.target.slotId, s.f.target.slotId);
  assert.deepEqual(s.f.calls.signals, [15], "the stuck container was signalled once");
  assert.equal(s.f.calls.destroy, 1);
  assert.deepEqual(s.stops(), ["destroy_after_grace"], "one stop line");
});

test("no stop is sent while the cell's own start or activation is still returning", async (context) => {
  await context.test("a start still returning when its bound fires", async (step) => {
    const s = await stuckFleet(step);
    await s.state.reserve(s.f.target);
    await s.state.dispatch(s.f.target);
    // The container is up and the endpoint's start is done; the cell's start still reads its health.
    const returning = gate();
    let held = false;
    const original = s.f.stub.fetch;
    s.f.stub.fetch = async (request: Request) => {
      if (!held && new URL(request.url).pathname === "/health") {
        held = true;
        returning.reached();
        await returning.opened;
      }
      return original(request);
    };
    const starting = s.f.cell.start(s.f.target);
    await returning.arrived;
    assert.equal(s.f.ctx.container.running, true);
    assert.equal((await s.pass(startingBoundMs))?.phase, "quarantined");
    await s.pass();
    assert.deepEqual(s.f.calls.signals, [], "a start still returning owns its instance");
    assert.equal(await s.fenced(), false);
    // The start goes on and fails to activate.
    s.f.transport.refuse["/attest"] = "uncertain";
    returning.open();
    await assert.rejects(starting);
    assert.deepEqual(s.f.calls.signals, [], "the stop crossed the start that was returning");
    await s.pass();
    assert.deepEqual(s.f.calls.signals, [15], "once nothing returns, the start is stopped");
  });

  await context.test("an observed activation still waiting on its attestation", async (step) => {
    const s = await stuckFleet(step);
    await quarantinedStart(s);
    delete s.f.transport.refuse["/attest"];
    const attest = gate();
    const original = s.f.stub.fetch;
    s.f.stub.fetch = async (request: Request) => {
      if (new URL(request.url).pathname === "/attest") {
        attest.reached();
        await attest.opened;
      }
      return original(request);
    };
    const observing = s.f.cell.observe(s.f.target);
    await attest.arrived;
    await s.pass();
    assert.deepEqual(s.f.calls.signals, [], "an activation still returning owns its instance");
    assert.equal(await s.fenced(), false);
    attest.open();
    assert.equal((await observing)?.bootId, s.f.identity().bootId);
    const row = await s.pass();
    assert.equal(row?.phase, "ready", "the cell that proved itself is admitted");
    assert.deepEqual(s.f.calls.signals, []);
  });
});

test("an activated cell is never stopped on this path", async (context) => {
  await context.test("a row with an identity keeps the failure path", async (step) => {
    const s = await stuckFleet(step);
    await s.state.reserve(s.f.target);
    await s.state.dispatch(s.f.target);
    s.f.transport.refuse["/attest"] = "uncertain";
    await assert.rejects(s.f.cell.start(s.f.target));
    // The ledger holds the boot as admitted, though its endpoint never recorded an attestation.
    await s.state.ready(s.f.identity());
    await s.state.quarantine(s.f.identity(), "runtime_failed");
    s.f.hooks.health = async () => unready();
    const row = await s.pass();
    assert.equal(row?.phase, "quarantined");
    assert.deepEqual(s.f.calls.signals, [], "an admitted cell's container is left to `failed`");
    assert.equal(await s.fenced(), false);
  });

  await context.test(
    "an attestation queued at the endpoint ahead of the fence wins",
    async (step) => {
      const s = await stuckFleet(step);
      await s.state.reserve(s.f.target);
      await s.state.dispatch(s.f.target);
      // The old isolate's activation reaches the endpoint and waits inside its health read.
      const attesting = gate();
      let holding = false;
      const original = s.f.stub.fetch;
      s.f.stub.fetch = async (request: Request) => {
        if (new URL(request.url).pathname === "/attest") holding = true;
        return original(request);
      };
      s.f.hooks.health = async () => {
        if (!holding) return;
        holding = false;
        attesting.reached();
        await attesting.opened;
      };
      const starting = s.f.cell.start(s.f.target).then(
        () => "activated",
        () => "refused",
      );
      await attesting.arrived;
      // A replaced controller abandons the slot and asks for its stop while that attestation runs.
      const abandoning = s.f.replacedCell().abandon(s.f.target, true);
      attesting.open();
      assert.equal(await abandoning, false);
      assert.equal(await starting, "refused", "the fence refuses the activation's last step");
      await s.f.settle();
      assert.equal(await s.fenced(), true);
      assert.deepEqual(s.f.calls.signals, [], "an attested start proved itself to its endpoint");
    },
  );

  await context.test("an activated first start is never fenced", async (step) => {
    const s = await stuckFleet(step);
    const identity = await s.f.cell.start(s.f.target);
    assert.equal(await s.f.cell.abandon(s.f.target, true), false);
    assert.equal(await s.f.replacedCell().abandon(s.f.target, true), false, "nor by a fresh cell");
    await s.f.settle();
    assert.equal(await s.fenced(), false, "the activated slot was fenced");
    assert.deepEqual(s.f.calls.signals, []);
    await assert.doesNotReject(s.f.cell.healthy(identity), "it no longer answers");
  });
});

test("a start that activates after its bound fired is admitted and serves, never stopped", async (context) => {
  const s = await stuckFleet(context);
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  const boot = gate();
  let held = false;
  s.f.hooks.health = async () => {
    if (held) return;
    held = true;
    boot.reached();
    await boot.opened;
  };
  const starting = s.f.cell.start(s.f.target);
  await boot.arrived;
  assert.equal((await s.pass(startingBoundMs))?.phase, "quarantined", "the bound fired");
  // Its activation completes before any quarantined pass could send a stop.
  boot.open();
  const identity = await starting;
  const row = await s.pass();
  assert.equal(row?.phase, "ready");
  assert.equal(row?.identity?.bootId, identity.bootId);
  assert.equal(row?.reason, undefined, "the quarantine's reason left with it");
  assert.equal(await s.forward(), 200, "it serves");
  assert.deepEqual(s.f.calls.signals, []);
  assert.equal(await s.fenced(), false);
});

test("the stop is sent once per row, through repeated passes, a replaced controller and a replaced endpoint", async (context) => {
  let releaseGrace!: () => void;
  const grace = new Promise<void>((resolve) => (releaseGrace = resolve));
  // Before the fixture's cleanup, which waits on the stop, even when an assertion failed first.
  context.after(() => releaseGrace());
  // Home keeps draining: the stop's grace doesn't end until the test lets it.
  const s = await stuckFleet(context, { grace: () => grace });
  await quarantinedStart(s);
  await s.pass(upkeepCadenceMs, false);
  assert.deepEqual(s.f.calls.signals, [15]);
  assert.equal(s.f.ctx.container.running, true, "the stop is under way");
  await s.pass(upkeepCadenceMs, false);
  assert.deepEqual(s.f.calls.signals, [15], "a repeated pass signalled again");
  s.replaceController();
  await s.pass(upkeepCadenceMs, false);
  assert.deepEqual(s.f.calls.signals, [15], "a fresh controller and cell signalled again");
  // Past the grace the object whose own run is still under way leaves the stop to it.
  await s.pass(forcedStopGraceMs, false);
  assert.deepEqual(s.f.calls.signals, [15]);
  assert.equal(s.f.calls.destroy, 0, "a stop still under way was taken over");
  // A replaced object finds the stop past its grace with no run of its own, and finishes it.
  s.replaceEndpoint();
  await s.pass(upkeepCadenceMs, false);
  assert.deepEqual(s.f.calls.signals, [15], "a replaced endpoint signalled again");
  assert.equal(s.f.calls.destroy, 1);
  assert.equal(s.f.ctx.container.running, false);
  // The replaced object's own run, which a real replacement takes with it, then finds it gone.
  assert.equal(s.stops()[0], "destroy_after_grace");
  releaseGrace();
  await s.f.settle();
});

test("a replaced endpoint leaves a stop still inside its grace to run", async (context) => {
  let releaseGrace!: () => void;
  const grace = new Promise<void>((resolve) => (releaseGrace = resolve));
  // Before the fixture's cleanup, which waits on the stop, even when an assertion failed first.
  context.after(() => releaseGrace());
  const s = await stuckFleet(context, { grace: () => grace });
  await quarantinedStart(s);
  await s.pass(upkeepCadenceMs, false);
  assert.deepEqual(s.f.calls.signals, [15]);
  s.replaceEndpoint();
  await s.pass(forcedStopGraceMs - 2 * upkeepCadenceMs, false);
  assert.deepEqual(s.f.calls.signals, [15], "a replaced endpoint signalled again");
  assert.equal(s.f.calls.destroy, 0, "a stop inside its grace was cut short");
  assert.equal(s.f.ctx.container.running, true);
  releaseGrace();
  await s.f.settle();
});

test("an endpoint on older code that doesn't know the stop fails closed and is asked again", async (context) => {
  const s = await stuckFleet(context);
  await quarantinedStart(s);
  const current = s.f.stub.fetch;
  const old = (answer: (request: Request, body: { target: unknown }) => Promise<Response>) => {
    s.f.stub.fetch = async (request: Request) => {
      if (new URL(request.url).pathname !== "/abandon-start") return current(request);
      return answer(request, await request.json());
    };
  };
  // Older code decodes the fence alone and never sees the stop.
  old((request, { target }) =>
    current(
      new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      }),
    ),
  );
  let row = await s.pass();
  assert.equal(row?.phase, "quarantined");
  assert.equal(await s.fenced(), true);
  assert.deepEqual(s.f.calls.signals, [], "a fence alone stops nothing");
  // Older code still that answers the action as not found.
  old(async () => new Response(null, { status: 404 }));
  assert.equal(await s.f.cell.abandon(s.f.target, true), false, "a refusal is no failed pass");
  row = await s.pass();
  assert.equal(row?.phase, "quarantined");
  assert.deepEqual(s.f.calls.signals, []);
  // The endpoint runs the new code: the stop goes out on the next pass, once.
  s.f.stub.fetch = current;
  await s.pass();
  assert.deepEqual(s.f.calls.signals, [15]);
  await s.pass();
  assert.deepEqual(s.f.calls.signals, [15]);
});
