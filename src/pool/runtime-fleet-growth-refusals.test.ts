import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { stillRefusedMs } from "./runtime-fleet/growth-refusals.ts";
import { upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";

/**
 * A real fleet cell, its provider read included, under one controller on the controller's own
 * clock, with demand for one cell. A pass advances the clock one upkeep cadence, then runs upkeep,
 * which retries an unsent start and grows.
 */
async function growing(context: TestContext) {
  const info = context.mock.method(console, "info", () => {});
  const warn = context.mock.method(console, "warn", () => {});
  context.mock.method(console, "error", () => {});
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  let now = 1_000_000;
  const state = new RuntimeFleetState(f.storage, 4, () => now);
  const pending: Promise<unknown>[] = [];
  const fleet = new RuntimeFleet({
    state,
    target: async () => f.target,
    cell: () => f.cell,
    legacyActive: async () => 0,
    currentRequests: () => 1,
    targetActive: 1,
    idleMilliseconds: 600_000,
    maximum: 4,
    defer: (work) => {
      pending.push(work);
    },
    wrap: f.wrap,
    now: () => now,
  });
  const pass = async () => {
    now += upkeepCadenceMs;
    await fleet.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return state.inspect();
  };
  const lines = (method: typeof info, name: string) =>
    method.mock.calls
      .filter((call) => call.arguments[0] === name)
      .map((call) => call.arguments[1] as unknown);
  return {
    f,
    pass,
    info: (name: string) => lines(info, name),
    warn: (name: string) => lines(warn, name),
  };
}

const refused = (reason: string) => ({
  step: null,
  reason,
  cause: null,
  error: "ProviderObservationRefused",
  provider: "provider_observation_refused",
  read: "launch",
});

test("a rollout refusal logs at info with its read and reason, once still refused past 30 s, and once recovered", async (context) => {
  const g = await growing(context);
  g.f.rollout(true);
  let [row] = await g.pass();
  assert.equal(row?.phase, "uncertain");
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_REFUSED"), [refused("rollout_active")]);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_REFUSED"), []);
  // Each pass retries the unsent start; none is still refused before the episode lasted 30 s.
  const before = stillRefusedMs / upkeepCadenceMs - 1;
  for (let index = 0; index < before; index++) await g.pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  await g.pass();
  const still = {
    refusedMs: stillRefusedMs,
    attempts: before + 2,
    read: "launch",
    reason: "rollout_active",
  };
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), [still]);
  for (let index = 0; index < 3; index++) await g.pass();
  assert.deepEqual(
    g.info("POOL_FLEET_GROWTH_STILL_REFUSED"),
    [still],
    "logged again in one episode",
  );
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), []);
  g.f.rollout(false);
  [row] = await g.pass();
  assert.notEqual(row?.phase, "uncertain");
  await g.pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [
    {
      refusedMs: stillRefusedMs + 4 * upkeepCadenceMs,
      attempts: before + 5,
      read: "launch",
      reason: "rollout_active",
    },
  ]);
  // The refusal line itself logged once for the whole episode, and nothing warned.
  assert.equal(g.info("POOL_FLEET_GROWTH_REFUSED").length, 1);
  for (const name of [
    "POOL_FLEET_GROWTH_REFUSED",
    "POOL_FLEET_GROWTH_STILL_REFUSED",
    "POOL_FLEET_GROWTH_RECOVERED",
  ])
    assert.deepEqual(g.warn(name), [], name);
});

test("any other refusal warns with its read and reason, and a short episode recovers without a still line", async (context) => {
  const g = await growing(context);
  // The provider refuses the observation token: a 403.
  g.f.failApplication(true);
  await g.pass();
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_REFUSED"), [refused("credential_refused")]);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_REFUSED"), []);
  g.f.failApplication(false);
  await g.pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [
    { refusedMs: upkeepCadenceMs, attempts: 1, read: "launch", reason: "credential_refused" },
  ]);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
});
