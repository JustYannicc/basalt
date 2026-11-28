import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  gate,
  stuckFleet,
  unready,
  type Stuck,
} from "../../scripts/pool-tests/runtime-fleet-stuck-fixture.ts";
import { FleetRefused } from "./runtime-fleet/state.ts";
import { startingBoundMs, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";
import { poolLifecycle } from "./lifecycle.ts";
import { forcedStopGraceMs } from "./runtime-slots/forced-restart-timing.ts";

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

/**
 * Pass after pass until its place is reclaimed, within the stop's grace and the absence bound of
 * its quarantine: one stop, SIGTERM first, then destroy once the grace ran out with Home still up.
 */
async function reclaimedAfterStop(s: Stuck, quarantinedAt: number) {
  let row;
  while ((row = await s.pass()) !== undefined) {
    assert.equal(row.phase, "quarantined", "a stopped start was admitted");
    assert.ok(
      Date.now() - quarantinedAt <= forcedStopGraceMs + startingBoundMs + 3 * upkeepCadenceMs,
      "the place wasn't reclaimed within the stop grace and the absence bound",
    );
  }
  assert.deepEqual(s.f.calls.signals, [15], "not one graceful stop, SIGTERM first");
  assert.equal(s.f.calls.destroy, 1);
  assert.deepEqual(s.stops(), ["destroy_after_grace"], "one stop line");
  assert.equal(s.f.ctx.container.running, false);
}

/** The stop's grace held until `release`, as for a Home still draining its SIGTERM. */
function heldGrace(context: TestContext) {
  let release!: () => void;
  const grace = new Promise<void>((resolve) => (release = resolve));
  // Before the fixture's cleanup, which waits on the stop, even when an assertion failed first.
  context.after(() => release());
  return { grace: () => grace, release: () => release() };
}

/** While its stop's grace runs, a call goes to the root and is served, and none reaches the cell. */
async function rootServesDuringStop(s: Stuck) {
  assert.deepEqual(s.f.calls.signals, [15], "the stop isn't under way");
  assert.equal(s.f.ctx.container.running, true, "the stop already ended");
  const before = s.rootCalls();
  assert.equal(await s.forward(), 200);
  assert.equal(s.rootCalls(), before + 1, "a call during the stop didn't go to the root");
}

/** No call ever reached the cell's container, so no stream was admitted to it at any point. */
function noStreamAdmitted(s: Stuck) {
  assert.equal(s.f.calls.model, 0, "a call reached the stopped cell's container");
  assert.deepEqual(s.f.transport.modelStubs, [], "a call was routed to the stopped cell");
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

// Readiness answers the start's own reads and then lapses for good. With 4 or 5 good reads the
// endpoint records the attestation before the activation's proof fails, so nothing is selected.
for (const good of [2, 4, 5])
  test(`a first start whose readiness answers ${good} reads and then lapses is stopped once at its bound and its place reclaimed, attested or not`, async (context) => {
    const s = await stuckFleet(context);
    await s.state.reserve(s.f.target);
    await s.state.dispatch(s.f.target);
    let reads = 0;
    s.f.hooks.health = async () => (++reads <= good ? undefined : unready());
    await assert.rejects(s.f.cell.start(s.f.target));
    const attested = await s.attested();
    assert.equal(attested, good >= 4, "the lapse didn't fall where the case needs it");
    assert.equal(await s.f.cell.selected(), undefined, "it activated");
    const row = await s.pass(startingBoundMs);
    assert.equal(row?.phase, "quarantined");
    assert.equal(row?.reason, "start_unproven");
    assert.equal(row?.identity, undefined);
    assert.deepEqual(s.f.calls.signals, [], "stopped before its quarantine");
    await reclaimedAfterStop(s, row!.phaseAt!);
  });

test("an attestation queued at the endpoint ahead of the fence lands, yet its activation is refused and its start stopped once", async (context) => {
  const s = await stuckFleet(context);
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
  assert.equal(await s.attested(), true, "the attestation lost");
  assert.equal(await s.f.cell.selected(), undefined, "a selection committed behind the fence");
  assert.equal(await s.fenced(), true);
  assert.deepEqual(s.f.calls.signals, [15], "the attested start was spared");
  assert.equal(s.f.calls.destroy, 1);
  assert.deepEqual(s.stops(), ["destroy_after_grace"]);
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

test("a start whose selection commits after a replaced controller fenced its slot and asked its stop is never made ready, and is stopped once and its place reclaimed", async (context) => {
  const held = heldGrace(context);
  const s = await stuckFleet(context, { grace: held.grace });
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  const slow = slowProof(s);
  const starting = s.f.cell.start(s.f.target);
  await slow.boundFires();
  const quarantinedAt = (await s.row())!.phaseAt!;
  // A replaced controller reads no selection while that read is held: it fences and asks the stop.
  s.replaceController();
  assert.equal((await s.pass(upkeepCadenceMs, false))?.phase, "quarantined");
  assert.equal(await s.fenced(), true);
  assert.deepEqual(s.f.calls.signals, [15], "the attested start was spared");
  // The old isolate's selection commits behind the fence while Home drains.
  slow.commit();
  assert.equal((await starting).bootId, s.f.identity().bootId);
  await rootServesDuringStop(s);
  held.release();
  await s.f.settle();
  await neverServes(s, "a fenced cell was admitted ready");
  await reclaimedAfterStop(s, quarantinedAt);
  noStreamAdmitted(s);
});

test("the old isolate's growth never admits its start once a replaced controller fenced its slot, and the start is stopped once", async (context) => {
  const held = heldGrace(context);
  const s = await stuckFleet(context, { demand: 1, grace: held.grace });
  const slow = slowProof(s);
  const grown = await s.grow();
  await slow.boundFires();
  const quarantinedAt = (await s.row())!.phaseAt!;
  s.replaceController();
  assert.equal((await s.pass(upkeepCadenceMs, false))?.phase, "quarantined");
  assert.equal(await s.fenced(), true);
  assert.deepEqual(s.f.calls.signals, [15], "the attested start was spared");
  // Its selection commits behind the fence while Home drains, and the old growth goes on to admit it.
  slow.commit();
  await grown();
  assert.equal((await s.f.cell.selected())?.bootId, s.f.identity().bootId, "it never activated");
  await rootServesDuringStop(s);
  held.release();
  await s.f.settle();
  await neverServes(s, "a fenced cell was admitted ready");
  assert.equal(s.f.calls.start, 1, "growth started it again");
  await reclaimedAfterStop(s, quarantinedAt);
  noStreamAdmitted(s);
});

test("a growth admission that runs while a replaced controller's fence is on its way never makes the cell ready, and the fence stops it once", async (context) => {
  const held = heldGrace(context);
  const s = await stuckFleet(context, { demand: 1, grace: held.grace });
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
  const quarantinedAt = (await s.row())!.phaseAt!;
  // A replaced controller reads no selection, so its fence and stop go out; they are held on their way.
  s.replaceController();
  holdFence = true;
  const fencing = s.pass(upkeepCadenceMs, false);
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
  // Its selection committed before the fence landed, yet after the cell's read: the fence stops it.
  await rootServesDuringStop(s);
  held.release();
  await s.f.settle();
  await neverServes(s, "a fenced cell was admitted ready");
  await reclaimedAfterStop(s, quarantinedAt);
  noStreamAdmitted(s);
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
