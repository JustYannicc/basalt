import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { startingBoundMs, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";
import { forcedStopGraceMs } from "./runtime-slots/forced-restart-timing.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";

interface Inspected {
  resources: {
    phase: string;
    reason?: string;
    identity?: unknown;
    firstStart?: unknown;
    target: { slotId: string };
  }[];
}

test("through the deployed wiring, a first start that attested but never activated reads attested in the fleet inspect, and is stopped once and its place reclaimed", async (context) => {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  const warn = context.mock.method(console, "warn", () => {});
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  type Runtime = Parameters<Parameters<typeof f.onRuntimeCreated>[0]>[0];
  let cell: Runtime | undefined;
  f.onRuntimeCreated(async (runtime) => {
    if (cell) return;
    cell = runtime;
    // Readiness answers the start and its attestation, then lapses before the activation's proof.
    let reads = 0;
    runtime.hooks.health = async () =>
      ++reads <= 4 ? undefined : new Response(null, { status: 503 });
  });
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "attested-stop",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const row = async () =>
    ((await f.send("fleet-inspect")) as Inspected).resources.find(
      (value) => value.target.slotId === slot,
    );
  const pass = async (milliseconds: number) => {
    now += milliseconds;
    await f.upkeep();
    await f.settle();
  };
  // The call that wants a cell: the root serves it while growth's first start fails to activate.
  const first = await f.model();
  assert.equal(first.status, 200);
  await first.body?.cancel();
  await f.settle();
  assert.ok(cell, "growth started no cell");
  const slot = cell.target.slotId;
  const store = new RuntimeWitnessStore(cell.ctx.storage, cell.env.POOL_DEPLOYMENT_KEY!);
  assert.ok(
    (await store.retained(slot))?.attestation,
    "the lapse didn't fall after the attestation",
  );
  assert.equal((await row())?.firstStart, undefined, "a start still in its bound read one");
  await pass(startingBoundMs);
  const held = await row();
  assert.equal(held?.phase, "quarantined");
  assert.equal(held?.reason, "start_unproven");
  assert.equal(held?.identity, undefined);
  // The inspect's read, again and again, never stops it; the next fleet pass does.
  assert.equal(held?.firstStart, "attested");
  assert.equal((await row())?.firstStart, "attested");
  assert.deepEqual(cell.calls.signals, [], "the inspect or the quarantine signalled it");
  const quarantinedAt = now;
  await pass(upkeepCadenceMs);
  assert.deepEqual(cell.calls.signals, [15], "the attested start wasn't stopped, SIGTERM first");
  assert.equal(cell.ctx.container.running, false);
  assert.equal((await row())?.firstStart, "attested", "the fence hid its attestation");
  // Its place frees once the provider has listed it absent for the absence bound.
  await pass(upkeepCadenceMs);
  assert.notEqual(await row(), undefined, "its place was reclaimed before the absence bound");
  await pass(startingBoundMs);
  assert.equal(await row(), undefined, "its place wasn't reclaimed at the absence bound");
  assert.ok(
    now - quarantinedAt <= forcedStopGraceMs + startingBoundMs + 3 * upkeepCadenceMs,
    "its place wasn't reclaimed within the stop grace and the absence bound",
  );
  assert.deepEqual(cell.calls.signals, [15], "it was signalled again");
  assert.deepEqual(
    warn.mock.calls
      .filter((call) => call.arguments[0] === "POOL_RUNTIME_ABANDONED_STOP")
      .map((call) => (call.arguments[1] as { path: string }).path),
    ["destroy_after_grace"],
    "not one stop line",
  );
});
