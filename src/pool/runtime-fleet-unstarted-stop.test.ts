import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import { FleetRefused, RuntimeFleetState } from "./runtime-fleet/state.ts";
import { startingBoundMs, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";
import { poolLifecycle } from "./lifecycle.ts";
import { forcedStopGraceMs } from "./runtime-slots/forced-restart-timing.ts";
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
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  f.timing.stopGrace = options.grace ?? (async () => context.mock.timers.tick(forcedStopGraceMs));
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
  let rootCalls = 0;
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
    /**
     * One fleet alarm that starts growth, which reserves the fixture's slot, starts it and admits
     * it. Later passes leave that growth running, so a test can hold its start across them.
     */
    async grow() {
      await fleet.upkeep();
      const growth = pending.splice(0);
      return () => Promise.allSettled(growth);
    },
    fenced: () => store.abandoned(f.target.slotId),
    stops: () =>
      warn.mock.calls
        .filter((call) => call.arguments[0] === "POOL_RUNTIME_ABANDONED_STOP")
        .map((call) => (call.arguments[1] as { path: string }).path),
    /** One model call. The root answers 200 and counts it; a cell would answer it itself. */
    forward: async () => {
      const response = await fleet.forward(
        new Request("http://pool/v1/responses", { method: "POST" }),
        undefined,
        async (_request, beforeDispatch) => {
          beforeDispatch();
          rootCalls++;
          return new Response(null, { status: 200 });
        },
        () => {},
      );
      await response.text();
      return response.status;
    },
    rootCalls: () => rootCalls,
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

/** A start whose container boots so slowly that its bound fires first, then activates. */
async function lateStart(s: Stuck) {
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
  boot.open();
  return starting;
}

/**
 * A container that takes almost the whole start bound to boot, and an activation whose last proof
 * read is held after its attestation, each until the test opens its gate.
 */
function slowProof(s: Stuck) {
  const boot = gate();
  const proof = gate();
  let attested = false;
  let readsAfterAttest = 0;
  let holdNext = false;
  const original = s.f.stub.fetch;
  s.f.stub.fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/attest") attested = true;
    else if (attested && path === "/health" && ++readsAfterAttest === 2) holdNext = true;
    return original(request);
  };
  let booted = false;
  s.f.hooks.health = async () => {
    if (!booted) {
      booted = true;
      boot.reached();
      await boot.opened;
      return;
    }
    if (!holdNext) return;
    holdNext = false;
    proof.reached();
    await proof.opened;
  };
  return {
    /** The bound fires while that proof read is held, so its selection can only commit late. */
    async boundFires() {
      await boot.arrived;
      assert.equal((await s.pass(startingBoundMs - 5_000))?.phase, "warming");
      boot.open();
      await proof.arrived;
      assert.equal((await s.pass(5_000))?.phase, "quarantined", "the bound fired");
    },
    commit: proof.open,
  };
}

/** Now and pass after pass the row stays an unproven quarantine, and a call goes to the root. */
async function neverServes(s: Stuck, message: string) {
  for (let index = 0; index < 4; index++) {
    const row = index === 0 ? await s.row() : await s.pass();
    assert.notEqual(row?.phase, "ready", message);
    assert.equal(row?.phase, "quarantined");
    assert.equal(row?.reason, "start_unproven");
    assert.equal(row?.identity, undefined);
  }
  const before = s.rootCalls();
  assert.equal(await s.forward(), 200);
  assert.equal(s.rootCalls(), before + 1, "the call didn't go to the root");
  assert.deepEqual(s.f.transport.modelStubs, [], "a call was routed to the cell");
}

/**
 * Longer than every bound that frees a start that never activated, its container still running.
 * The provider lists it stopped throughout, so only its endpoint's own read keeps its place.
 */
async function heldWhileRunning(s: Stuck) {
  s.f.listAs("inactive");
  const from = Date.now();
  while (
    Date.now() - from <=
    startingBoundMs + forcedStopGraceMs + startingBoundMs + 3 * upkeepCadenceMs
  ) {
    const row = await s.pass();
    assert.notEqual(row?.phase, "ready", "a late start was admitted ready");
    assert.equal(row?.phase, "quarantined", "a running cell's place was reclaimed");
    assert.equal(row?.identity, undefined);
  }
  assert.equal(s.f.ctx.container.running, true);
  assert.deepEqual(s.f.calls.signals, [], "a cell whose selection committed was stopped");
  assert.equal(s.f.calls.destroy, 0);
  s.f.listAs(undefined);
}

/** The platform ends its container, as at its inactivity timeout: its place frees at the absence bound. */
async function freedOnceEnded(s: Stuck) {
  s.f.ctx.container.signal(9);
  const endedAt = Date.now();
  while ((await s.pass()) !== undefined)
    assert.ok(
      Date.now() - endedAt < startingBoundMs + 2 * upkeepCadenceMs,
      "its place was never freed once its container ended",
    );
  assert.ok(Date.now() - endedAt >= startingBoundMs, "the absence rule was shortened");
  assert.deepEqual(s.f.calls.signals, [9], "this path signalled it");
  assert.equal(s.f.calls.destroy, 0);
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
    // It activated after its bound fired, so it is fenced but never admitted or stopped.
    await neverServes(s, "a late start was admitted ready");
    assert.equal(await s.fenced(), true, "an activated start's slot was left unfenced");
    assert.deepEqual(s.f.calls.signals, [], "a cell whose selection committed was stopped");
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

  await context.test(
    "an activated first start is fenced, and its stop is never asked for",
    async (step) => {
      const s = await stuckFleet(step);
      const identity = await s.f.cell.start(s.f.target);
      assert.equal(await s.f.cell.abandon(s.f.target, true), false);
      assert.equal(
        await s.f.replacedCell().abandon(s.f.target, true),
        false,
        "nor by a fresh cell",
      );
      await s.f.settle();
      // Its endpoint would refuse the stop for an attested start too; the cell never asks for it.
      assert.deepEqual(s.f.transport.abandons, [false, false], "the stop was asked for");
      assert.equal(await s.fenced(), true, "the activated slot was left unfenced");
      assert.deepEqual(s.f.calls.signals, []);
      assert.equal(s.f.ctx.container.running, true);
      await assert.rejects(s.f.cell.healthy(identity), "a fenced endpoint still answered");
    },
  );
});

test("a start that activates after its bound fired is fenced but never admitted or stopped, so its container times out and its place frees", async (context) => {
  const s = await stuckFleet(context);
  let renewedAt = Date.now();
  s.f.hooks.keepAlive = async () => {
    renewedAt = Date.now();
  };
  // Its activation completes before any quarantined pass, and it answers every read after.
  const identity = await lateStart(s);
  assert.equal((await s.f.cell.selected())?.bootId, identity.bootId, "its selection committed");
  await assert.doesNotReject(s.f.cell.healthy(identity), "it answers its read");
  await neverServes(s, "a late start was admitted ready");
  const renewals = s.f.calls.keepAlive;
  await heldWhileRunning(s);
  // Passes every minute and its endpoint's alarm every five, as while a cell serves, until its
  // inactivity timeout has run out since its last renewal; past the fence no alarm renews it.
  let alarms = 0;
  for (let minute = 1; Date.now() - renewedAt < poolLifecycle.idleTimeoutMs; minute++) {
    assert.equal(
      (await s.pass(60_000))?.phase,
      "quarantined",
      "a running cell's place was reclaimed",
    );
    if (minute % 5 === 0) {
      await s.f.endpoint.alarm();
      alarms++;
    }
    assert.equal(s.f.calls.keepAlive, renewals, "its endpoint kept renewing its container");
  }
  assert.ok(alarms >= 12, "less than an hour of alarms ran");
  assert.equal(await s.fenced(), true, "a late start's slot was left unfenced");
  assert.deepEqual(s.f.calls.signals, [], "a cell whose selection committed was stopped");
  assert.equal(s.f.ctx.container.running, true);
  // The platform ends it at that timeout.
  await freedOnceEnded(s);
  assert.deepEqual(await s.state.inspect(), []);
});

test("a late start that never answers its read is fenced but never stopped while it runs, and frees its place once it ends", async (context) => {
  const s = await stuckFleet(context);
  await lateStart(s);
  // Its readiness lapsed with its activation, so no admission read ever answers.
  s.f.hooks.health = async () => unready();
  await heldWhileRunning(s);
  assert.equal(await s.fenced(), true, "a late start's slot was left unfenced");
  await freedOnceEnded(s);
  assert.deepEqual(await s.state.inspect(), []);
});

test("a start whose selection commits after a replaced controller fenced its slot is never made ready, and frees its place once it ends", async (context) => {
  const s = await stuckFleet(context);
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  const slow = slowProof(s);
  const starting = s.f.cell.start(s.f.target);
  await slow.boundFires();
  // A replaced controller fences the slot while that read is held.
  s.replaceController();
  assert.equal((await s.pass())?.phase, "quarantined");
  assert.equal(await s.fenced(), true);
  // The old isolate's selection commits behind the fence.
  slow.commit();
  assert.equal((await starting).bootId, s.f.identity().bootId);
  await neverServes(s, "a fenced cell was admitted ready");
  assert.equal(await s.fenced(), true);
  await heldWhileRunning(s);
  await freedOnceEnded(s);
});

test("the old isolate's growth never admits its start once a replaced controller fenced its slot", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  const slow = slowProof(s);
  const grown = await s.grow();
  await slow.boundFires();
  s.replaceController();
  assert.equal((await s.pass())?.phase, "quarantined");
  assert.equal(await s.fenced(), true);
  // Its selection commits behind the fence, and the old growth goes on to admit it.
  slow.commit();
  await grown();
  assert.equal((await s.f.cell.selected())?.bootId, s.f.identity().bootId, "it never activated");
  await neverServes(s, "a fenced cell was admitted ready");
  assert.equal(s.f.calls.start, 1, "growth started it again");
  assert.deepEqual(s.f.calls.signals, []);
});

test("a growth admission that runs while a replaced controller's fence is on its way never makes the cell ready", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  const slow = slowProof(s);
  const fence = gate();
  const admission = gate();
  let holdFence = false;
  let holdAdmission = false;
  const inner = s.f.stub.fetch;
  s.f.stub.fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (holdFence && path === "/abandon-start") {
      holdFence = false;
      fence.reached();
      await fence.opened;
    } else if (holdAdmission && path === "/health") {
      holdAdmission = false;
      const response = await inner(request);
      admission.reached();
      await admission.opened;
      return response;
    }
    return inner(request);
  };
  const grown = await s.grow();
  await slow.boundFires();
  // A replaced controller reads no selection, so its fence goes out; it is held on its way.
  s.replaceController();
  holdFence = true;
  const fencing = s.pass();
  await fence.arrived;
  // The old selection commits and its growth admits it while the slot is still unfenced. A health
  // read it makes answers, and its answer is held until the fence has landed.
  holdAdmission = true;
  slow.commit();
  await Promise.race([grown(), admission.arrived]);
  holdAdmission = false;
  fence.open();
  assert.equal((await fencing)?.phase, "quarantined");
  assert.equal(await s.fenced(), true, "the ordering wasn't reproduced");
  admission.open();
  await grown();
  assert.equal((await s.f.cell.selected())?.bootId, s.f.identity().bootId, "it never activated");
  await neverServes(s, "a fenced cell was admitted ready");
  assert.deepEqual(s.f.calls.signals, []);
});

test("an admission whose start's bound fires during its read is refused by the ledger, and growth settles", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  // Its start activates in time; the admission's own health read is held past the bound.
  const admission = gate();
  let held = false;
  const original = s.f.stub.fetch;
  s.f.stub.fetch = async (request: Request) => {
    if (
      held ||
      new URL(request.url).pathname !== "/health" ||
      !(await s.f.cell.selected().catch(() => undefined))
    )
      return original(request);
    held = true;
    const response = await original(request);
    admission.reached();
    await admission.opened;
    return response;
  };
  const grown = await s.grow();
  await admission.arrived;
  assert.equal((await s.row())?.phase, "warming", "the admission read a starting row");
  const row = await s.pass(startingBoundMs);
  assert.equal(row?.phase, "quarantined", "the bound fired");
  assert.equal(row?.reason, "start_unproven");
  admission.open();
  await grown();
  await neverServes(s, "the ledger made a quarantined row ready");
  await assert.rejects(
    s.state.ready(s.f.identity()),
    (error) => error instanceof FleetRefused && error.reason === "uncertain",
  );
  assert.equal(s.f.calls.start, 1, "growth started it again");
  assert.deepEqual(s.f.calls.signals, []);
  assert.equal(await s.fenced(), true, "an activated start's slot was left unfenced");
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

test("a stop whose destroy failed is finished by a later pass of the same endpoint, never signalled again", async (context) => {
  const s = await stuckFleet(context);
  await quarantinedStart(s);
  const quarantinedAt = (await s.row())!.phaseAt!;
  let failures = 1;
  s.f.hooks.destroy = () => {
    if (failures-- > 0) throw new Error("synthetic destroy failure");
  };
  await s.pass();
  assert.deepEqual(s.stops(), ["stop_failed"]);
  assert.deepEqual(s.f.calls.signals, [15]);
  assert.equal(s.f.ctx.container.running, true, "the failed destroy left it running");
  // The same endpoint object, past the grace the failed run already spent.
  await s.pass();
  assert.deepEqual(
    s.stops(),
    ["stop_failed", "destroy_after_grace"],
    "the same object never retried the stop",
  );
  assert.deepEqual(s.f.calls.signals, [15], "the retry signalled again");
  assert.equal(s.f.calls.destroy, 1);
  assert.equal(s.f.ctx.container.running, false);
  let row;
  while ((row = await s.pass()) !== undefined) {
    assert.equal(row.phase, "quarantined");
    assert.ok(
      Date.now() - quarantinedAt <= forcedStopGraceMs + startingBoundMs + 3 * upkeepCadenceMs,
      "the place wasn't reclaimed within the stop grace and the absence bound",
    );
  }
  assert.deepEqual(s.f.calls.signals, [15]);
  assert.equal(s.f.calls.destroy, 1);
  assert.deepEqual(s.stops(), ["stop_failed", "destroy_after_grace"]);
});

test("an endpoint on older code that doesn't know the stop fails closed and is asked again", async (context) => {
  const s = await stuckFleet(context);
  await quarantinedStart(s);
  // Older code decodes the fence alone and never sees the stop.
  s.f.transport.older = "fence";
  let row = await s.pass();
  assert.equal(row?.phase, "quarantined");
  assert.equal(await s.fenced(), true);
  assert.deepEqual(s.f.calls.signals, [], "a fence alone stops nothing");
  // Older code still, which answers the action as not found.
  s.f.transport.older = "missing";
  assert.equal(await s.f.cell.abandon(s.f.target, true), false, "a refusal is no failed pass");
  row = await s.pass();
  assert.equal(row?.phase, "quarantined");
  assert.deepEqual(s.f.calls.signals, []);
  // The endpoint runs the new code: the stop goes out on the next pass, once.
  s.f.transport.older = undefined;
  await s.pass();
  assert.deepEqual(s.f.calls.signals, [15]);
  await s.pass();
  assert.deepEqual(s.f.calls.signals, [15]);
});
