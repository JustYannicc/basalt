import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";
import { distanceClass, readinessDistance } from "./runtime-distance.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

// Placement trial, 2026-11-18: TCP connect from each draw to the database region.
const frankfurt = {
  boot_id: "b",
  started_at: "s",
  db_rtt_state: "measured",
  db_rtt_ms: 5,
  db_rtt_max_ms: 6,
  db_rtt_samples: 7,
  location: "fra07",
};
const amsterdam = { ...frankfurt, db_rtt_ms: 14, db_rtt_max_ms: 18, location: "ams08" };
const athens = { ...frankfurt, db_rtt_ms: 44, db_rtt_max_ms: 48, location: "ath01" };
const lisbon = { ...frankfurt, db_rtt_ms: 40, db_rtt_max_ms: 47, location: "lis01" };

test("readiness distance follows the contract and anything else is unknown", () => {
  assert.deepEqual(readinessDistance(frankfurt), {
    state: "measured",
    rttMs: 5,
    location: "fra07",
  });
  assert.equal(distanceClass(readinessDistance(frankfurt)), "near");
  assert.equal(distanceClass(readinessDistance(amsterdam)), "near");
  assert.equal(distanceClass(readinessDistance(athens)), "far");
  assert.equal(distanceClass(readinessDistance(lisbon)), "far");
  assert.equal(
    distanceClass(readinessDistance({ ...athens, db_rtt_state: "held" })),
    "far",
    "a held draw never started Home",
  );
  for (const unknown of [
    { boot_id: "b", started_at: "s" },
    { ...frankfurt, db_rtt_state: "failed", db_rtt_ms: undefined, db_rtt_samples: 1 },
    { ...frankfurt, db_rtt_state: "pending" },
    { ...frankfurt, db_rtt_state: "measuring" },
  ])
    assert.equal(distanceClass(readinessDistance(unknown)), "unknown");
  for (const malformed of [
    { ...frankfurt, db_rtt_ms: 0 },
    { ...frankfurt, db_rtt_ms: 3_501 },
    { ...frankfurt, db_rtt_ms: 4.5 },
    { ...frankfurt, db_rtt_ms: "5" },
  ])
    assert.equal(readinessDistance(malformed), undefined);
  assert.deepEqual(
    readinessDistance({ ...frankfurt, location: "Frankfurt" }),
    { state: "measured", rttMs: 5 },
    "a malformed location keeps the valid distance",
  );
});

async function fleet() {
  const state = new RuntimeFleetState(new SlotMemory(), 4, () => 100);
  let index = 0;
  const add = async (body: object | undefined) => {
    index++;
    const target = {
      format: "pool-runtime-slot-v1" as const,
      controllerId: "controller",
      slotId: `slot-${index}`,
      applicationId: "blue",
      applicationVersion: "1",
      instanceId: `instance-${index}`,
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageInput: "image",
      homePeerOrdinal: index,
    };
    const identity: SlotIdentity = { ...target, bootId: `boot-${index}` };
    await state.reserve(target);
    await state.dispatch(target);
    await state.ready(identity);
    await state.observeDistance(identity, body ? readinessDistance(body) : undefined);
    return identity;
  };
  return { state, add };
}
const placement = (primary: "near" | "far" | "unknown") => ({ comfortable: 2, primary });

test("near runtimes take requests first, far and unknown ones take the overflow", async () => {
  const f = await fleet();
  const far = await f.add(athens);
  const near = await f.add(frankfurt);
  const picks: string[] = [];
  for (let request = 0; request < 4; request++) {
    const reservation = await f.state.acquire(
      Number.MAX_SAFE_INTEGER,
      "balanced",
      placement("unknown"),
    );
    picks.push(reservation.kind === "primary" ? "root" : reservation.identity.slotId);
  }
  // The near cell fills to the growth target, then the far cell and the old-image root share it.
  assert.deepEqual(picks, [near.slotId, near.slotId, "root", far.slotId]);
});

test("the root keeps its tie preference among equals, and nothing changes without distances", async () => {
  const near = await fleet();
  await near.add(amsterdam);
  const first = await near.state.acquire(Number.MAX_SAFE_INTEGER, "balanced", placement("near"));
  assert.equal(first.kind, "primary", "a near root wins the tie against a near cell");

  const old = await fleet();
  const cell = await old.add(undefined);
  const picks: string[] = [];
  for (let request = 0; request < 3; request++) {
    const reservation = await old.state.acquire(
      Number.MAX_SAFE_INTEGER,
      "balanced",
      placement("unknown"),
    );
    picks.push(reservation.kind === "primary" ? "root" : reservation.identity.slotId);
  }
  // Today's order: the root on ties, the cell when the root is busier.
  assert.deepEqual(picks, ["root", cell.slotId, "root"]);
});

test("a lone far runtime still serves", async () => {
  const f = await fleet();
  const far = await f.add(lisbon);
  const reservation = await f.state.acquire(
    Number.MAX_SAFE_INTEGER,
    undefined,
    placement("unknown"),
  );
  assert.equal(reservation.kind === "runtime" && reservation.identity.slotId, far.slotId);
});

test("fleet upkeep records each cell's reported distance where the operator reads the fleet", async () => {
  const { RuntimeFleet } = await import("./runtime-fleet/controller.ts");
  const f = await fleet();
  const cell = await f.add(undefined);
  const never = async (): Promise<never> => {
    throw new Error("unexpected");
  };
  const runtime = new RuntimeFleet({
    state: f.state,
    target: never,
    cell: () => ({
      start: never,
      observe: async () => cell,
      selected: async () => cell,
      healthy: async () => readinessDistance(athens),
      forward: never,
      install: async () => {},
      abortPool: () => {},
      drain: async () => ({ active: 0, known: true }),
      retire: never,
      retired: async () => false,
      failed: async () => false,
    }),
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 2,
    idleMilliseconds: 3_600_000,
    maximum: 4,
    defer: () => {},
    wrap: (response) => response,
    now: () => 100,
    primaryDistance: async () => readinessDistance(lisbon),
  });
  await runtime.upkeep();
  const [row] = await f.state.inspect();
  assert.deepEqual(row?.database, { state: "measured", rttMs: 44, location: "ath01" });
});

function redrawFleet(draws: object[], serving: boolean, active: () => number = () => 0) {
  let rootServing = serving;
  let clock = 100;
  const unhealthy = new Set<string>();
  const memory = new SlotMemory();
  const state = new RuntimeFleetState(memory, 4, () => clock);
  const placements: Record<string, unknown>[] = [];
  const retired: string[] = [];
  let index = 0;
  const distances = new Map<string, object>();
  const reserveNext = async () => {
    index++;
    const target = {
      format: "pool-runtime-slot-v1" as const,
      controllerId: "controller",
      slotId: `slot-${index}`,
      applicationId: "blue",
      applicationVersion: "1",
      instanceId: `instance-${index}`,
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageInput: "image",
      homePeerOrdinal: index,
    };
    distances.set(target.slotId, draws[index - 1]!);
    await state.reserve(target);
    return target;
  };
  const never = async (): Promise<never> => {
    throw new Error("unexpected");
  };
  return {
    state,
    memory,
    placements,
    retired,
    reserveNext,
    distances,
    unhealthy,
    advance: (ms: number) => {
      clock += ms;
    },
    stopRoot: () => {
      rootServing = false;
    },
    build: async () => {
      const { RuntimeFleet } = await import("./runtime-fleet/controller.ts");
      return new RuntimeFleet({
        state,
        target: never,
        cell: () => ({
          start: async (target) => ({ ...target, bootId: `boot-${target.slotId}` }),
          observe: async () => undefined,
          selected: async () => undefined,
          healthy: async (identity) => {
            if (unhealthy.has(identity.slotId)) throw new Error("unhealthy");
            return readinessDistance(distances.get(identity.slotId));
          },
          forward: never,
          install: async () => {},
          abortPool: () => {},
          drain: async () => ({ active: 0, known: true }),
          retire: async (identity, begin) => {
            await begin();
            retired.push(identity.slotId);
            return true;
          },
          retired: async () => true,
          failed: async () => false,
        }),
        legacyActive: async () => 0,
        currentRequests: active,
        targetActive: 2,
        idleMilliseconds: 3_600_000,
        maximum: 4,
        defer: () => {},
        wrap: (response) => response,
        now: () => clock,
        primary: "balanced",
        primaryAvailable: () => rootServing,
      });
    },
  };
}

test("a far cell is redrawn while the root serves, never takes a request and stops gracefully", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  const f = redrawFleet([athens], true);
  const runtime = await f.build();
  const target = await f.reserveNext();
  await runtime.upkeep();
  const [row] = await f.state.inspect();
  assert.equal(row?.phase, "draining");
  assert.equal(row?.active, 0);
  assert.deepEqual(row?.database, { state: "measured", rttMs: 44, location: "ath01" });
  const reservation = await f.state.acquire(
    Number.MAX_SAFE_INTEGER,
    "balanced",
    placement("unknown"),
  );
  assert.equal(reservation.kind, "primary", "the redrawn cell is never routable");
  await reservation.release();
  await runtime.upkeep();
  assert.deepEqual(f.retired, [target.slotId], "retired through the zero-activity drain");
  const placements = log.mock.calls
    .filter((call) => call.arguments[0] === "POOL_RUNTIME_PLACEMENT")
    .map((call) => call.arguments[1]);
  assert.deepEqual(placements, [
    {
      slot: target.slotId,
      decision: "redraw",
      draw: 1,
      class: "far",
      state: "measured",
      location: "ath01",
      dbRttMs: 44,
    },
  ]);
});

test("a lone far cell serves, a near draw is admitted, and the fourth far draw serves", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  const decisions = () =>
    log.mock.calls
      .filter((call) => call.arguments[0] === "POOL_RUNTIME_PLACEMENT")
      .map((call) => [call.arguments[1].decision, call.arguments[1].draw]);

  const alone = redrawFleet([lisbon], false);
  const lone = await alone.build();
  await alone.reserveNext();
  await lone.upkeep();
  assert.equal(
    (await alone.state.inspect())[0]?.phase,
    "ready",
    "a down pool is worse than a slow one",
  );

  const near = redrawFleet([athens, frankfurt], true);
  const nearFleet = await near.build();
  await near.reserveNext();
  await nearFleet.upkeep();
  await near.reserveNext();
  await nearFleet.upkeep();
  assert.equal(
    (await near.state.inspect()).find((row) => row.target.slotId === "slot-2")?.phase,
    "ready",
  );

  const limit = redrawFleet([athens, athens, lisbon, athens], true);
  const limited = await limit.build();
  for (let draw = 0; draw < 4; draw++) {
    await limit.reserveNext();
    await limited.upkeep();
  }
  const last = (await limit.state.inspect()).find((row) => row.target.slotId === "slot-4");
  assert.equal(last?.phase, "ready", "after the limit the last draw serves");
  assert.deepEqual(decisions(), [
    ["admit_alone", 1],
    ["redraw", 1],
    ["admit", 2],
    ["redraw", 1],
    ["redraw", 2],
    ["redraw", 3],
    ["admit_after_limit", 4],
  ]);
});

const placementDecisions = (log: { mock: { calls: { arguments: unknown[] }[] } }) =>
  log.mock.calls
    .filter((call) => call.arguments[0] === "POOL_RUNTIME_PLACEMENT")
    .map((call) => {
      const line = call.arguments[1] as { slot: string; decision: string; draw: number };
      return [line.slot, line.decision, line.draw];
    });
const phaseOf = async (f: ReturnType<typeof redrawFleet>, slot: string) =>
  (await f.state.inspect()).find((row) => row.target.slotId === slot)?.phase;

test("with demand for two cells, the first far draw beside a ready cell serves at once", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  // Four calls in flight at two per cell: the demand of the moment wants two cells.
  const f = redrawFleet([frankfurt, athens, athens, athens, athens], true, () => 4);
  const runtime = await f.build();
  await f.reserveNext();
  await runtime.upkeep();
  let draws = 0;
  while (draws < 4) {
    draws++;
    const target = await f.reserveNext();
    await runtime.upkeep();
    if ((await phaseOf(f, target.slotId)) === "ready") break;
  }
  assert.equal(draws, 1, "the far cell the fleet needs serves on its first draw, not its fourth");
  assert.deepEqual(placementDecisions(log), [
    ["slot-1", "admit", 1],
    ["slot-2", "admit_needed", 1],
  ]);
  // Among the cells, with the near one fenced off, the far cell is the one that takes the call.
  const reservation = await f.state.acquire(
    Number.MAX_SAFE_INTEGER,
    undefined,
    placement("unknown"),
    (identity) => identity.slotId === "slot-1",
  );
  assert.equal(reservation.identity.slotId, "slot-2");
  await reservation.release();
  assert.deepEqual(f.retired, []);
});

test("a far draw beside a cell that is fenced, with only the root serving, is redrawn", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  const f = redrawFleet([frankfurt, athens], true, () => 4);
  const runtime = await f.build();
  const first = await f.reserveNext();
  await runtime.upkeep();
  // Its reads fail from here on, so it stays suspect and takes no call.
  f.unhealthy.add(first.slotId);
  await f.state.suspect({ ...first, bootId: `boot-${first.slotId}` }, () => ({ suspect: {} }));
  await f.reserveNext();
  await runtime.upkeep();
  assert.deepEqual(placementDecisions(log), [
    ["slot-1", "admit", 1],
    ["slot-2", "redraw", 1],
  ]);
});

test("a far draw the demand no longer wants at admit is redrawn and retired as before", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  let inFlight = 4;
  const f = redrawFleet([frankfurt, athens], true, () => inFlight);
  const runtime = await f.build();
  await f.reserveNext();
  await runtime.upkeep();
  await f.reserveNext();
  inFlight = 2;
  await runtime.upkeep();
  assert.equal(await phaseOf(f, "slot-2"), "draining");
  await runtime.upkeep();
  assert.deepEqual(f.retired, ["slot-2"]);
  assert.deepEqual(placementDecisions(log), [
    ["slot-1", "admit", 1],
    ["slot-2", "redraw", 1],
  ]);
});

test("a first far cell beside only the root keeps the redraw rule under any demand", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  const f = redrawFleet([athens, athens, lisbon, athens], true, () => 10);
  const runtime = await f.build();
  for (let draw = 0; draw < 4; draw++) {
    await f.reserveNext();
    await runtime.upkeep();
  }
  assert.deepEqual(placementDecisions(log), [
    ["slot-1", "redraw", 1],
    ["slot-2", "redraw", 2],
    ["slot-3", "redraw", 3],
    ["slot-4", "admit_after_limit", 4],
  ]);
});

test("a needed far draw serves only within neededFarMs; farther or held draws are redrawn", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  const decisionFor = async (draw: object) => {
    log.mock.resetCalls();
    const f = redrawFleet([frankfurt, draw], true, () => 4);
    const runtime = await f.build();
    await f.reserveNext();
    await runtime.upkeep();
    await f.reserveNext();
    await runtime.upkeep();
    return placementDecisions(log)[1]?.[1];
  };
  assert.equal(await decisionFor({ ...athens, db_rtt_ms: 50 }), "admit_needed");
  assert.equal(await decisionFor({ ...athens, db_rtt_ms: 51 }), "redraw");
  assert.equal(await decisionFor({ ...athens, db_rtt_ms: 150 }), "redraw");
  assert.equal(await decisionFor({ ...athens, db_rtt_state: "held" }), "redraw");
});

test("the draw count survives a controller reset, so resets can't redraw past the limit", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  const f = redrawFleet([athens, athens, athens, athens], true);
  for (let draw = 0; draw < 4; draw++) {
    // Each draw is admitted by a fresh controller on the same durable state.
    const runtime = await f.build();
    await f.reserveNext();
    await runtime.upkeep();
  }
  assert.deepEqual(placementDecisions(log), [
    ["slot-1", "redraw", 1],
    ["slot-2", "redraw", 2],
    ["slot-3", "redraw", 3],
    ["slot-4", "admit_after_limit", 4],
  ]);
  assert.equal(await f.state.placementDraws(), 0, "the admission ends the run of redraws");
});

test("a run of redraws left by demand that stopped starts over, and so does an unreadable count", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  const f = redrawFleet([athens, athens, athens, athens, athens], true);
  const runtime = await f.build();
  for (let draw = 0; draw < 3; draw++) {
    await f.reserveNext();
    await runtime.upkeep();
  }
  // Two start bounds later, the next far draw is the first of a new run, not the fourth.
  f.advance(2 * 240_000 + 1);
  await f.reserveNext();
  await runtime.upkeep();
  await f.memory.put("runtime-fleet-v1:placement-draws", { count: "three" });
  await f.reserveNext();
  await runtime.upkeep();
  assert.deepEqual(placementDecisions(log), [
    ["slot-1", "redraw", 1],
    ["slot-2", "redraw", 2],
    ["slot-3", "redraw", 3],
    ["slot-4", "redraw", 1],
    ["slot-5", "redraw", 1],
  ]);
});

test("without distances the order is today's on both sides of the growth target", async () => {
  const picks = async (withPlacement: boolean) => {
    const f = await fleet();
    await f.add(undefined);
    await f.add(undefined);
    const order: string[] = [];
    for (let request = 0; request < 7; request++) {
      const reservation = await f.state.acquire(
        Number.MAX_SAFE_INTEGER,
        "balanced",
        withPlacement ? placement("unknown") : undefined,
      );
      order.push(reservation.kind === "primary" ? "root" : reservation.identity.slotId);
    }
    return order;
  };
  assert.deepEqual(await picks(true), await picks(false));
});

test("a redraw is recorded once per boot and never applies to a replacement", async () => {
  const f = await fleet();
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "controller",
    slotId: "slot-replacement",
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: "instance-replacement",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: 9,
  };
  const far = { ...target, slotId: "slot-far", instanceId: "instance-far", homePeerOrdinal: 8 };
  await f.state.reserve(far);
  await f.state.dispatch(far);
  const boot = { ...far, bootId: "boot-far" };
  assert.equal(await f.state.redraw(boot, readinessDistance(athens)), true);
  assert.equal(await f.state.redraw(boot, readinessDistance(athens)), false);
  const previous = { ...target, slotId: "slot-old", bootId: "boot-old" };
  await f.state.reserve(target, undefined, { previous });
  await f.state.dispatch(target);
  await assert.rejects(
    f.state.redraw({ ...target, bootId: "boot-replacement" }, readinessDistance(athens)),
    /uncertain/,
  );
});

test("a far cell is kept if the runtime that justified its redraw stops before it is retired", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = redrawFleet([athens], true);
  const runtime = await f.build();
  await f.reserveNext();
  await runtime.upkeep();
  assert.equal((await f.state.inspect())[0]?.phase, "draining");
  f.stopRoot();
  await runtime.upkeep();
  assert.equal((await f.state.inspect())[0]?.phase, "ready", "the only runtime is never stopped");
  assert.deepEqual(f.retired, []);
});

test("with the root down, another ready near cell still justifies a redraw", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = redrawFleet([frankfurt, athens], false);
  const runtime = await f.build();
  await f.reserveNext();
  await runtime.upkeep();
  await f.reserveNext();
  await runtime.upkeep();
  const rows = await f.state.inspect();
  assert.equal(rows.find((row) => row.target.slotId === "slot-1")?.phase, "ready");
  assert.equal(rows.find((row) => row.target.slotId === "slot-2")?.redrawn, true);
});

test("a far replacement serves wherever it landed", async (context) => {
  const log = context.mock.method(console, "info", () => {});
  const f = redrawFleet([], true);
  const runtime = await f.build();
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "controller",
    slotId: "slot-7",
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: "instance-7",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: 7,
  };
  f.distances.set("slot-7", athens);
  await f.state.reserve(target, undefined, {
    previous: { ...target, slotId: "slot-gone", bootId: "b" },
  });
  await runtime.upkeep();
  assert.equal((await f.state.inspect())[0]?.phase, "ready");
  const decision = log.mock.calls.find((call) => call.arguments[0] === "POOL_RUNTIME_PLACEMENT")
    ?.arguments[1].decision;
  assert.equal(decision, "admit_replacement");
});
