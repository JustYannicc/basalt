import assert from "node:assert/strict";
import { readEnd } from "./runtime-slots/container-end.ts";
import { test, type TestContext } from "node:test";
import { Schema } from "effect";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { runtimeGrant } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";
import { RuntimeActivity } from "./runtime-slots/activity.ts";
import { RuntimeRetirementObservation } from "./runtime-slots/contract.ts";
import { runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import { forcedStopGraceMs } from "./runtime-slots/forced-restart-timing.ts";
import { pastBound, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";

/** A started fleet cell, drained to zero, behind the production endpoint. */
async function startedCell(context: TestContext, drained = true) {
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "a".repeat(64),
    slotId: "graceful-cell",
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: "b".repeat(64),
    imageDigest: `sha256:${"c".repeat(64)}`,
    imageInput: "2".repeat(16),
    homePeerOrdinal: 1,
  };
  const f = await handoffRuntime(target, {
    POOL_RUNTIME_APPLICATION_ID: "blue",
    POOL_CONTAINER_APPLICATION_ID: "legacy",
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-management",
    POOL_APP_SIGNING_KEY: "d".repeat(64),
    POOL_IMAGE_HASH: target.imageInput,
    POOL_DEPLOYMENT_KEY: "e".repeat(64),
  });
  const controller = new RuntimeSqlite();
  context.after(async () => {
    await f.cleanup();
    await controller.close();
  });
  const grant = await runtimeGrant(f, controller, "initial-start");
  await f.endpoint.admit(grant.envelope);
  const { identity } = await f.endpoint.start(target, AbortSignal.timeout(5_000));
  if (drained) await f.endpoint.drain(identity, AbortSignal.timeout(2_000));
  const store = new RuntimeWitnessStore(f.storage, f.env.POOL_DEPLOYMENT_KEY!);
  return { f, target, identity, store, provider: grant.proof.provider };
}

/** Home still draining its claimed refreshes: SIGTERM arrives, and the container keeps running. */
function drainingHome(f: Awaited<ReturnType<typeof startedCell>>["f"]) {
  let signalled!: () => void;
  const sigterm = new Promise<void>((resolve) => (signalled = resolve));
  f.ctx.container.signal = (signal: number) => {
    f.calls.signals.push(signal);
    signalled();
  };
  return sigterm;
}

function heldGrace(context: TestContext) {
  let over!: () => void;
  const grace = new Promise<void>((resolve) => (over = resolve));
  context.mock.method(runtimeStopTiming, "stopGrace", () => grace);
  return over;
}

test("a retirement sends SIGTERM and destroys only once the grace has run out", async (context) => {
  const { f, target, identity, store } = await startedCell(context);
  const sigterm = drainingHome(f);
  const graceOver = heldGrace(context);
  const retiring = f.endpoint.retire(target, identity, AbortSignal.timeout(30_000));
  const first = await Promise.race([
    sigterm.then(() => "signalled"),
    retiring.then(() => "retired"),
  ]);
  assert.equal(first, "signalled", "the container was destroyed without a stop signal");
  assert.deepEqual(f.calls.signals, [15]);
  assert.equal(f.calls.destroy, 0, "destroyed while Home was still draining");
  assert.notEqual((await store.retained(target.slotId))?.retired, true);
  graceOver();
  await f.settle();
  assert.equal(f.calls.destroy, 1);
  assert.equal((await store.retained(target.slotId))?.retired, true);
});

test("a cell that stops on SIGTERM retires at once, without waiting out the grace", async (context) => {
  const { f, target, identity, store } = await startedCell(context);
  f.hooks.sigtermExits = true;
  context.mock.method(runtimeStopTiming, "stopGrace", () => new Promise<void>(() => {}));
  await f.endpoint.retire(target, identity, AbortSignal.timeout(5_000));
  await f.settle();
  assert.deepEqual(f.calls.signals, [15]);
  // An exited instance is listed inactive as a destroyed one is; a destroy now would change nothing.
  assert.equal(f.calls.destroy, 0);
  assert.equal((await store.retained(target.slotId))?.retired, true);
});

test("a stop longer than its caller's budget answers it without failing, and the retirement read sees it end", async (context) => {
  const { f, target, identity, provider } = await startedCell(context);
  drainingHome(f);
  const graceOver = heldGrace(context);
  await f.endpoint.retire(target, identity, AbortSignal.timeout(200));
  assert.deepEqual(f.calls.signals, [15], "retire answered before its stop began");
  assert.equal(f.calls.destroy, 0);
  assert.deepEqual(await f.endpoint.retirement(identity), {
    identity,
    retired: false,
    running: true,
    stopping: true,
    provider,
  });
  graceOver();
  await f.settle();
  assert.equal(f.calls.destroy, 1);
  const { end, ...retired } = await f.endpoint.retirement(identity);
  assert.deepEqual(retired, { identity, retired: true, running: false, provider });
  assert.equal(readEnd(end)?.stopSent, true, "a stop we sent read as a crash");
});

test("a monitor() rejection that is no exit keeps the stop to the grace", async (context) => {
  const { f, target, identity } = await startedCell(context);
  drainingHome(f);
  f.ctx.container.monitor = async () => {
    throw new Error("monitor transport lost");
  };
  const graceOver = heldGrace(context);
  await f.endpoint.retire(target, identity, AbortSignal.timeout(200));
  assert.equal(f.calls.destroy, 0, "a transport failure was taken for an exit");
  graceOver();
  await f.settle();
  assert.equal(f.calls.destroy, 1);
});

test("a latched cell whose SIGTERM was never sent is reported stuck, not stopping", async (context) => {
  const { f, identity, provider } = await startedCell(context);
  await new RuntimeActivity(f.storage).retire(identity);
  assert.deepEqual(await f.endpoint.retirement(identity), {
    identity,
    retired: false,
    running: true,
    provider,
  });
});

test("a stop still running past its grace is reported stuck, not stopping", async (context) => {
  const { f, target, identity } = await startedCell(context);
  drainingHome(f);
  const graceOver = heldGrace(context);
  await f.endpoint.retire(target, identity, AbortSignal.timeout(200));
  const observed = Schema.decodeUnknownSync(RuntimeRetirementObservation);
  assert.equal(observed(await f.endpoint.retirement(identity)).stopping, true);
  const now = Date.now();
  context.mock.method(Date, "now", () => now + forcedStopGraceMs + 31_000);
  assert.equal(observed(await f.endpoint.retirement(identity)).stopping, undefined);
  context.mock.restoreAll();
  graceOver();
  await f.settle();
});

test("a fleet cell's retire call that times out while its stop runs is pending, not failed", async (context) => {
  // Held before the fixture exists, which leaves a grace a test set first in place.
  const graceOver = heldGrace(context);
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  assert.deepEqual(await f.cell.drain(selected), { active: 0, known: true });
  const sigterm = drainingHome(f);
  const fetch = f.stub.fetch.bind(f.stub);
  // As in production, the call's own budget runs out after SIGTERM while the endpoint keeps stopping.
  f.stub.fetch = async (request: Request) => {
    if (new URL(request.url).pathname !== "/retire") return fetch(request);
    void fetch(request).catch(() => {});
    await sigterm;
    throw new Error("caller budget ran out");
  };
  assert.equal(await f.cell.retire(selected, async () => {}), false);
  assert.equal(f.calls.destroy, 0, "the stop never waited on the grace the test held");
  graceOver();
  await f.settle();
  assert.equal(await f.cell.retired(selected), true);
});

test("a caller that gives up right after the retiring latch still gets its cell stopped", async (context) => {
  const { f, target, identity, provider } = await startedCell(context);
  const caller = new AbortController();
  const retire = RuntimeActivity.prototype.retire;
  context.mock.method(
    RuntimeActivity.prototype,
    "retire",
    async function (this: RuntimeActivity, ...args: Parameters<RuntimeActivity["retire"]>) {
      await retire.apply(this, args);
      caller.abort();
    },
  );
  await assert.rejects(f.endpoint.retire(target, identity, caller.signal));
  await f.settle();
  assert.deepEqual(f.calls.signals, [15], "the latch held a live container that nothing signals");
  assert.equal(f.calls.destroy, 1);
  const { end, ...retired } = await f.endpoint.retirement(identity);
  assert.deepEqual(retired, { identity, retired: true, running: false, provider });
  assert.equal(readEnd(end)?.stopSent, true, "a stop we sent read as a crash");
});

test("an aborted start sends SIGTERM before any destroy", async (context) => {
  const { f, target, store } = await startedCell(context, false);
  const record = (await store.retained(target.slotId))!;
  const intent = {
    operationId: "graceful-abort",
    target,
    startupOperationId: record.authorization.operationId,
    witness: record.witness ?? null,
  };
  const sigterm = drainingHome(f);
  const graceOver = heldGrace(context);
  const aborting = f.endpoint.abortStartup(intent, AbortSignal.timeout(30_000));
  const first = await Promise.race([
    sigterm.then(() => "signalled"),
    aborting.then(() => "answered"),
  ]);
  assert.equal(first, "signalled", "the start was destroyed without a stop signal");
  assert.equal(f.calls.destroy, 0);
  assert.equal((await aborting)?.status, "pending");
  graceOver();
  await f.settle();
  assert.equal(f.calls.destroy, 1);
  assert.equal((await f.endpoint.inspectStartupAbort(intent)).status, "aborted");
});

test("the retiring bound covers a stop that runs out the whole grace, then the absence read", () => {
  // The endpoint's health read, the stop, one fleet tick, the retirement read and one absence probe.
  const worstMs = 2_000 + forcedStopGraceMs + upkeepCadenceMs + 2_000 + 15_000;
  assert.equal(pastBound({ phase: "retiring", phaseAt: 0 }, worstMs), false);
});
