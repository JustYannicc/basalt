import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState, type FleetRow } from "./runtime-fleet/state.ts";
import { GrowthRefusals, stillRefusedMs } from "./runtime-fleet/growth-refusals.ts";
import { startingBoundMs, upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";
import { ProviderObservationRefused } from "./runtime-provider/read.ts";
import { SlotRefused, type SlotTarget } from "./runtime-slots/contract.ts";

/** Each growth line by name, as logged at info and at warn. */
function captured(context: TestContext) {
  const info = context.mock.method(console, "info", () => {});
  const warn = context.mock.method(console, "warn", () => {});
  context.mock.method(console, "error", () => {});
  const lines = (method: typeof info, name: string) =>
    method.mock.calls
      .filter((call) => call.arguments[0] === name)
      .map((call) => call.arguments[1] as Record<string, unknown>);
  return {
    info: (name: string) => lines(info, name),
    warn: (name: string) => lines(warn, name),
  };
}

/**
 * A real fleet cell, its provider read included, under one controller on the controller's own
 * clock. A pass advances the clock one upkeep cadence, then runs upkeep, which retries an unsent
 * start and grows. Growth's target can refuse as production's does with no fleet configuration
 * record, which leaves no row behind, and `restart` builds the controller again over the same
 * state, as a replaced isolate does.
 */
async function growing(context: TestContext) {
  const lines = captured(context);
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  let now = 1_000_000,
    demand = 1,
    targetRefused = false;
  const state = new RuntimeFleetState(f.storage, 4, () => now);
  const pending: Promise<unknown>[] = [];
  const make = () =>
    new RuntimeFleet({
      state,
      target: async () => {
        if (targetRefused) throw new SlotRefused("selection");
        return f.target;
      },
      cell: () => f.cell,
      legacyActive: async () => 0,
      currentRequests: () => demand,
      targetActive: 1,
      idleMilliseconds: 600_000,
      maximum: 4,
      defer: (work) => {
        pending.push(work);
      },
      wrap: f.wrap,
      now: () => now,
    });
  let fleet = make();
  const pass = async () => {
    now += upkeepCadenceMs;
    await fleet.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return state.inspect();
  };
  return {
    ...lines,
    f,
    pass,
    restart: () => {
      fleet = make();
    },
    skip: (ms: number) => {
      now += ms;
    },
    demand: (value: number) => {
      demand = value;
    },
    refuseTarget: (value: boolean) => {
      targetRefused = value;
    },
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
/** What a provider refusal's latest try adds beside its reason: its class, no step, no cause. */
const refusedTry = { error: "ProviderObservationRefused", step: null, cause: null };
const rollout = (refusedMs: number, attempts: number) => ({
  refusedMs,
  attempts,
  ...refusedTry,
  read: "launch",
  reason: "rollout_active",
});
/** Passes until one stays refused this long, as upkeep retries every cadence. */
const stillAfter = stillRefusedMs / upkeepCadenceMs;

test("a rollout refusal logs at info with its read and reason, as does its still line past 30 s, and recovers once", async (context) => {
  const g = await growing(context);
  g.f.rollout(true);
  let [row] = await g.pass();
  assert.equal(row?.phase, "uncertain");
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_REFUSED"), [refused("rollout_active")]);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_REFUSED"), []);
  // Each pass retries the unsent start; none is still refused before the episode lasted 30 s.
  for (let index = 0; index < stillAfter - 1; index++) await g.pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  await g.pass();
  // A start held by an announced rollout is the designed state: its still line is info, not warn.
  const still = rollout(stillRefusedMs, stillAfter + 1);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), [still]);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  for (let index = 0; index < 3; index++) await g.pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), [still], "logged again");
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), []);
  g.f.rollout(false);
  [row] = await g.pass();
  assert.notEqual(row?.phase, "uncertain");
  await g.pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [
    rollout(stillRefusedMs + 4 * upkeepCadenceMs, stillAfter + 4),
  ]);
  // The refusal line itself logged once for the whole episode, at info.
  assert.equal(g.info("POOL_FLEET_GROWTH_REFUSED").length, 1);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_REFUSED"), []);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_RECOVERED"), []);
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
    {
      refusedMs: upkeepCadenceMs,
      attempts: 1,
      ...refusedTry,
      read: "launch",
      reason: "credential_refused",
    },
  ]);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
});

test("a refusal that left no start behind opens no episode, so an hour later a fresh refusal is only as old as it is", async (context) => {
  const g = await growing(context);
  g.refuseTarget(true);
  await g.pass();
  assert.equal(g.warn("POOL_FLEET_GROWTH_REFUSED").length, 1);
  // Demand ends; growth passes with nothing to do.
  g.demand(0);
  g.refuseTarget(false);
  for (let index = 0; index < 3; index++) await g.pass();
  g.skip(3_600_000);
  // Demand returns and its very first start is refused by a rollout, which clears a pass later.
  g.demand(1);
  g.f.rollout(true);
  await g.pass();
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  g.f.rollout(false);
  await g.pass();
  await g.pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [rollout(upkeepCadenceMs, 1)]);
});

test("after the isolate restarts, a still-refused retry opens a fresh episode and recovers it", async (context) => {
  const g = await growing(context);
  g.f.rollout(true);
  let [row] = await g.pass();
  assert.equal(row?.phase, "uncertain");
  g.restart();
  // The first episode was this isolate's memory; the retries count from the new isolate's first.
  for (let index = 0; index < 30; index++) [row] = await g.pass();
  assert.equal(row?.phase, "uncertain");
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), [
    rollout(stillRefusedMs, stillAfter + 1),
  ]);
  g.f.rollout(false);
  [row] = await g.pass();
  assert.equal(row?.phase, "ready");
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [rollout(30 * upkeepCadenceMs, 30)]);
  assert.equal(g.info("POOL_FLEET_GROWTH_REFUSED").length, 1);
});

/**
 * Stand-in cells under one controller, each drawn as a fresh slot whose start and its retry are
 * refused by a 429 on the launch read until the test admits that slot. Nothing is ever sent, so a
 * given-up slot is reclaimed at once. The cells are plain stand-ins: the episodes are the
 * controller's.
 */
async function standIns(context: TestContext, demand: number) {
  const lines = captured(context);
  let now = 1_000_000,
    slots = 0;
  const state = new RuntimeFleetState(new SlotMemory(), 4, () => now);
  const pending: Promise<unknown>[] = [];
  const refusing = new Set<string>();
  const limited = () =>
    Object.assign(new ProviderObservationRefused({ reason: "read_status", status: 429 }), {
      read: "launch" as const,
    });
  const cell = (target: SlotTarget): FleetCell => {
    const started = async () => {
      if (refusing.has(target.slotId)) throw limited();
      return { ...target, bootId: `boot-${target.homePeerOrdinal}` };
    };
    return {
      start: started,
      observe: started,
      selected: async () => undefined,
      forward: async () => new Response(null, { status: 503 }),
      install: async () => {},
      abortPool: () => {},
      drain: async () => ({ active: 0, known: true }),
      retire: async () => false,
      retired: async () => false,
      failed: async () => false,
      abandon: async () => true,
    };
  };
  const fleet = new RuntimeFleet({
    state,
    target: async () => {
      const slot = ++slots;
      refusing.add(`slot-${slot}`);
      return {
        format: "pool-runtime-slot-v1",
        controllerId: "controller",
        slotId: `slot-${slot}`,
        applicationId: "blue",
        applicationVersion: "1",
        instanceId: `instance-${slot}`,
        imageDigest: `sha256:${"a".repeat(64)}`,
        imageInput: "image",
        homePeerOrdinal: slot,
      };
    },
    cell,
    legacyActive: async () => 0,
    currentRequests: () => demand,
    targetActive: 1,
    idleMilliseconds: 600_000,
    maximum: 4,
    defer: (work) => {
      pending.push(work);
    },
    wrap: (response) => response,
    now: () => now,
  });
  const pass = async () => {
    now += upkeepCadenceMs;
    await fleet.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return state.inspect();
  };
  return {
    ...lines,
    pass,
    admit: (slot: string) => refusing.delete(slot),
    demand: (value: number) => {
      demand = value;
    },
    skip: (ms: number) => {
      now += ms;
    },
  };
}
const limited = (refusedMs: number, attempts: number) => ({
  refusedMs,
  attempts,
  ...refusedTry,
  read: "launch",
  reason: "read_status",
  status: 429,
});
const phases = (rows: readonly FleetRow[]) => rows.map((row) => [row.target.slotId, row.phase]);

test("a new slot refused long after an earlier slot's episode gets its own still line", async (context) => {
  const g = await standIns(context, 1);
  // Still refused at 30 s by anything but a rollout, here a rate limit, it warns once.
  let rows = await g.pass();
  for (let index = 0; index < stillAfter; index++) rows = await g.pass();
  assert.deepEqual(phases(rows), [["slot-1", "uncertain"]]);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), [
    limited(stillRefusedMs, stillAfter + 1),
  ]);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  // Demand ends; past its start bound the start is given up, then reclaimed, with no line.
  g.demand(0);
  const left = new Set<string>();
  for (let passes = 0; rows.length > 0; passes++) {
    assert.ok(passes < startingBoundMs / upkeepCadenceMs, "the start is never given up");
    rows = await g.pass();
    for (const row of rows) left.add(row.phase);
  }
  assert.ok(left.has("quarantined"));
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), []);
  g.skip(3_600_000);
  // Steady demand again, and a new slot's start is refused for two minutes, then admitted.
  g.demand(1);
  for (let index = 0; index < 60; index++) rows = await g.pass();
  assert.deepEqual(phases(rows), [["slot-2", "uncertain"]]);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), [
    limited(stillRefusedMs, stillAfter + 1),
    limited(stillRefusedMs, stillAfter + 1),
  ]);
  g.admit("slot-2");
  rows = await g.pass();
  assert.deepEqual(phases(rows), [["slot-2", "ready"]]);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [limited(60 * upkeepCadenceMs, 60)]);
});

test("another cell admitted meanwhile ends only its own episode, never one of a slot still refused", async (context) => {
  const g = await standIns(context, 2);
  // Demand for two cells: the first pass reserves slot 1, the second slot 2, and both are refused.
  await g.pass();
  let rows = await g.pass();
  assert.deepEqual(phases(rows), [
    ["slot-1", "uncertain"],
    ["slot-2", "uncertain"],
  ]);
  await g.pass();
  g.admit("slot-1");
  rows = await g.pass();
  assert.deepEqual(phases(rows), [
    ["slot-1", "ready"],
    ["slot-2", "uncertain"],
  ]);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [limited(3 * upkeepCadenceMs, 3)]);
  // Slot 2 stays refused, each retry counted against its own episode, until it warns at 30 s.
  for (let index = 0; index < stillAfter - 3; index++) await g.pass();
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  await g.pass();
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), [
    limited(stillRefusedMs, stillAfter + 1),
  ]);
  g.admit("slot-2");
  rows = await g.pass();
  assert.deepEqual(phases(rows), [
    ["slot-1", "ready"],
    ["slot-2", "ready"],
  ]);
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [
    limited(3 * upkeepCadenceMs, 3),
    limited(stillRefusedMs + upkeepCadenceMs, stillAfter + 1),
  ]);
});

test("a start still booting when the isolate is replaced reports its failed tries by class, then recovers", async (context) => {
  const g = captured(context);
  let now = 1_000_000;
  let booting = true;
  const state = new RuntimeFleetState(new SlotMemory(), 4, () => now);
  const target: SlotTarget = {
    format: "pool-runtime-slot-v1",
    controllerId: "controller",
    slotId: "slot-1",
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: "instance-1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: 1,
  };
  const cell = (isolate: number) => (): FleetCell => ({
    // The first isolate's start was sent and doesn't return before the isolate is replaced.
    start: () => new Promise(() => {}),
    observe: async () => {
      if (isolate === 1) return undefined;
      // A booting endpoint doesn't answer the new isolate's 2 s observe in time.
      if (booting) throw new DOMException("The operation timed out", "TimeoutError");
      return { ...target, bootId: "boot-1" };
    },
    selected: async () => undefined,
    forward: async () => new Response(null, { status: 503 }),
    install: async () => {},
    abortPool: () => {},
    drain: async () => ({ active: 0, known: true }),
    retire: async () => false,
    retired: async () => false,
    failed: async () => false,
    abandon: async () => false,
  });
  const fleet = (isolate: number, pending: Promise<unknown>[]) =>
    new RuntimeFleet({
      state,
      target: async () => target,
      cell: cell(isolate),
      legacyActive: async () => 0,
      currentRequests: () => 1,
      targetActive: 1,
      idleMilliseconds: 600_000,
      maximum: 4,
      defer: (work) => {
        pending.push(work);
      },
      wrap: (response) => response,
      now: () => now,
    });
  await fleet(1, []).upkeep();
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(phases(await state.inspect()), [["slot-1", "warming"]]);
  const pending: Promise<unknown>[] = [];
  const replaced = fleet(2, pending);
  const pass = async () => {
    now += upkeepCadenceMs;
    await replaced.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  for (let index = 0; index < stillAfter + 4; index++) await pass();
  const failed = { error: "Timeout", step: null, cause: null, read: null, reason: null };
  // Nothing refused it, so no refused line; the warming start's failed tries still have a length.
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_REFUSED"), []);
  assert.deepEqual(g.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), [
    { refusedMs: stillRefusedMs, attempts: stillAfter + 1, ...failed },
  ]);
  booting = false;
  await pass();
  assert.deepEqual(g.info("POOL_FLEET_GROWTH_RECOVERED"), [
    { refusedMs: stillRefusedMs + 4 * upkeepCadenceMs, attempts: stillAfter + 4, ...failed },
  ]);
});

test("an episode refused once for anything but a rollout still warns at 30 s, even when its latest try was a rollout", (context) => {
  const lines = captured(context);
  let now = 1_000_000;
  const refusals = new GrowthRefusals(() => now);
  const refusal = (reason: "rollout_active" | "read_status") => {
    const error = new ProviderObservationRefused(
      reason === "read_status" ? { reason, status: 429 } : { reason },
    );
    error.read = "launch";
    return error;
  };
  refusals.startRefused("slot-1", refusal("rollout_active"));
  now += stillRefusedMs / 2;
  refusals.startRefused("slot-1", refusal("read_status"));
  now += stillRefusedMs / 2;
  refusals.startRefused("slot-1", refusal("rollout_active"));
  assert.deepEqual(lines.info("POOL_FLEET_GROWTH_STILL_REFUSED"), []);
  assert.deepEqual(lines.warn("POOL_FLEET_GROWTH_STILL_REFUSED"), [rollout(stillRefusedMs, 3)]);
});
