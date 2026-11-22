import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { runtimeGrant } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";
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
  await retiring;
  assert.equal(f.calls.destroy, 1);
  assert.equal((await store.retained(target.slotId))?.retired, true);
});

test("a cell that stops on SIGTERM retires at once, without waiting out the grace", async (context) => {
  const { f, target, identity, store } = await startedCell(context);
  context.mock.method(runtimeStopTiming, "stopGrace", () => new Promise<void>(() => {}));
  await f.endpoint.retire(target, identity, AbortSignal.timeout(5_000));
  assert.deepEqual(f.calls.signals, [15]);
  assert.equal(f.calls.destroy, 0, "a container that exited on its own was destroyed anyway");
  assert.equal((await store.retained(target.slotId))?.retired, true);
});

test("the stop outlives its caller's budget, and the retirement read sees it finish", async (context) => {
  const { f, target, identity, provider } = await startedCell(context);
  const sigterm = drainingHome(f);
  const graceOver = heldGrace(context);
  await assert.rejects(f.endpoint.retire(target, identity, AbortSignal.timeout(100)));
  await sigterm;
  assert.equal(f.calls.destroy, 0);
  assert.deepEqual(await f.endpoint.retirement(identity), {
    identity,
    retired: false,
    running: true,
    provider,
  });
  graceOver();
  await f.settle();
  assert.equal(f.calls.destroy, 1);
  assert.deepEqual(await f.endpoint.retirement(identity), {
    identity,
    retired: true,
    running: false,
    provider,
  });
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
