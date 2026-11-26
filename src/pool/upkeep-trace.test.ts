import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { PoolRuntimeFleet } from "./runtime-fleet/production.ts";
import { RuntimeProviderReader } from "./runtime-provider/read.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { RuntimeHandoff } from "./runtime-slots/integration.ts";
import { PoolUpkeepTrace } from "./upkeep-trace.ts";

interface Line {
  invocation: number;
  side: string;
  phase: string;
  outcome: string;
  elapsedMs: number;
  phases?: Record<string, number>;
  failed?: string[];
  rows?: Array<{
    ordinal?: number;
    active?: number;
    phase: string;
    outcome: string;
    elapsedMs: number;
  }>;
  misses?: Array<Record<string, unknown>>;
  [field: string]: unknown;
}

/** The upkeep lines written so far, and a monotonic clock only the test moves. */
function capture(context: TestContext) {
  const info = context.mock.method(console, "info", () => {});
  const clock = { now: 0 };
  context.mock.method(performance, "now", () => clock.now);
  const lines = () =>
    info.mock.calls
      .filter(({ arguments: [name] }) => name === "POOL_RUNTIME_UPKEEP")
      .map(({ arguments: [, fields] }) => fields as Line);
  return { clock, lines };
}

test("a pass writes one line when it ends, with every phase's time and a zero-ms phase at 0", async (context) => {
  const { clock, lines } = capture(context);
  const trace = new PoolUpkeepTrace("alarm");
  await trace.pass("alarm", async () => {
    trace.observe({ homeDue: true, fleetDue: true });
    await trace.run("fleet", async () => {
      clock.now += 80;
    });
    await trace.run("rearm", async () => {});
  });
  const written = lines();
  assert.equal(written.length, 1, "no started, ended or observed lines of its own");
  const [line] = written;
  assert.equal(line!.side, "alarm");
  assert.equal(line!.phase, "alarm");
  assert.equal(line!.outcome, "ended");
  assert.equal(line!.elapsedMs, 80);
  assert.deepEqual(line!.phases, { fleet: 80, rearm: 0 });
  assert.equal(line!.homeDue, true);
  assert.equal(line!.fleetDue, true);
});

test("a phase still running at 1 s writes its pending line at once, and the pass line still comes at the end", async (context) => {
  const { clock, lines } = capture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const trace = new PoolUpkeepTrace("home");
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const pass = trace.pass("home", async () => {
    await trace.run("candidate_probe", async () => {});
    await trace.run("memberships", () => held);
  });
  // Let the pass reach the held phase before its pending timer can fire.
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  clock.now = 999;
  context.mock.timers.tick(999);
  assert.deepEqual(lines(), [], "nothing is written while every phase is under 1 s");
  clock.now = 1_000;
  context.mock.timers.tick(1);
  const pending = lines().filter((line) => line.outcome === "pending");
  assert.deepEqual(pending.map((line) => [line.phase, line.elapsedMs]).sort(), [
    ["home", 1_000],
    ["memberships", 1_000],
  ]);
  assert.ok(pending.every((line) => line.phases === undefined));
  clock.now = 1_400;
  release();
  await pass;
  const [line, ...rest] = lines().filter((line) => line.outcome !== "pending");
  assert.deepEqual(rest, []);
  assert.equal(line!.outcome, "ended");
  assert.equal(line!.elapsedMs, 1_400);
  assert.deepEqual(line!.phases, { candidate_probe: 0, memberships: 1_400 });
  assert.equal(line!.invocation, pending[0]!.invocation);
});

test("a pass that ends under 1 s writes no pending line after its own", async (context) => {
  const { clock, lines } = capture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const trace = new PoolUpkeepTrace("alarm");
  await trace.pass("alarm", async () => {
    await trace.run("fleet", async () => {
      clock.now += 400;
    });
  });
  clock.now = 2_000;
  context.mock.timers.tick(2_000);
  assert.deepEqual(
    lines().map((line) => [line.phase, line.outcome]),
    [["alarm", "ended"]],
  );
});

test("a phase that throws writes its error line at once, and a pass that throws still writes its line", async (context) => {
  const { clock, lines } = capture(context);
  const trace = new PoolUpkeepTrace("fleet");
  await assert.rejects(
    trace.pass("upkeep", async () => {
      await trace.run("snapshot", async () => {
        clock.now += 3;
      });
      await trace.run("ready", async () => {
        clock.now += 2;
        throw new Error("synthetic refusal");
      });
    }),
    /synthetic refusal/,
  );
  const written = lines();
  assert.deepEqual(
    written.map((line) => [line.phase, line.outcome]),
    [
      ["ready", "error"],
      ["upkeep", "error"],
    ],
  );
  assert.equal(written[0]!.elapsedMs, 2);
  assert.equal(written[0]!.phases, undefined);
  assert.deepEqual(written[1]!.phases, { snapshot: 3, ready: 2 });
  assert.deepEqual(written[1]!.failed, ["ready"], "the pass line names the phase that threw");
  assert.equal(written[0]!.invocation, written[1]!.invocation);
  assert.equal(typeof written[1]!.reason, "string");
});

test("a phase whose throw the pass catches keeps its reason on its error line, and the pass line names it", async (context) => {
  const { lines } = capture(context);
  const trace = new PoolUpkeepTrace("home");
  await trace.pass("home", async () => {
    await trace
      .run("candidate_probe", async () => {
        throw new SlotRefused("unhealthy");
      })
      .catch(() => {});
    await trace.run("memberships", async () => {});
  });
  const [error, line, ...rest] = lines();
  assert.deepEqual(rest, []);
  assert.deepEqual(
    [error!.phase, error!.outcome, error!.reason],
    ["candidate_probe", "error", "slot_unhealthy"],
  );
  assert.equal(line!.outcome, "ended");
  assert.equal(line!.reason, undefined);
  assert.deepEqual(line!.failed, ["candidate_probe"]);
  assert.deepEqual(line!.phases, { candidate_probe: 0, memberships: 0 });
});

test("rows sharing a phase add up under it, each with its own entry, and health misses ride the same line", async (context) => {
  const { clock, lines } = capture(context);
  const trace = new PoolUpkeepTrace("fleet");
  await trace.pass("upkeep", async () => {
    trace.missed({ ordinal: 3, quarantined: false, cause: "timeout", roundTripMs: 1_500 });
    for (const [ordinal, spent] of [
      [1, 5],
      [2, 7],
    ] as const)
      await trace.row("draining", { ordinal, active: 0 }, async () => {
        clock.now += spent;
      });
    await trace.row("ready", { ordinal: 3, active: 2 }, async () => {});
    await trace
      .row("ready", { ordinal: 4, active: 1 }, async () => {
        clock.now += 1;
        throw new Error("synthetic row failure");
      })
      .catch(() => {});
  });
  const [error, line, ...rest] = lines();
  assert.deepEqual(rest, []);
  assert.deepEqual([error!.phase, error!.outcome, error!.ordinal], ["ready", "error", 4]);
  assert.deepEqual(line!.phases, { draining: 12, ready: 1 });
  assert.deepEqual(line!.rows, [
    { ordinal: 1, active: 0, phase: "draining", outcome: "ended", elapsedMs: 5 },
    { ordinal: 2, active: 0, phase: "draining", outcome: "ended", elapsedMs: 7 },
    { ordinal: 3, active: 2, phase: "ready", outcome: "ended", elapsedMs: 0 },
    { ordinal: 4, active: 1, phase: "ready", outcome: "error", elapsedMs: 1 },
  ]);
  assert.deepEqual(line!.failed, ["ready"]);
  assert.deepEqual(line!.misses, [
    { ordinal: 3, quarantined: false, cause: "timeout", roundTripMs: 1_500 },
  ]);
});

test("called with no alarm's trace, the fleet's upkeep writes a fleet pass line of its own naming each row it kept and how long that row took", async (context) => {
  const { lines } = capture(context);
  const f = quietFleet();
  const first = await f.add();
  const second = await f.add();
  await f.pass();
  const fleet = lines().filter((line) => line.side === "fleet");
  assert.equal(fleet.length, 1, "one line for the pass, none per row");
  const [line] = fleet;
  assert.equal(line!.phase, "upkeep");
  assert.equal(line!.outcome, "ended");
  assert.equal(typeof line!.phases?.snapshot, "number");
  assert.equal(typeof line!.phases?.ready, "number");
  assert.deepEqual(
    line!.rows?.map(({ ordinal, active, phase, outcome }) => [ordinal, active, phase, outcome]),
    [
      [first.homePeerOrdinal, 0, "ready", "ended"],
      [second.homePeerOrdinal, 0, "ready", "ended"],
    ],
  );
  assert.equal(line!.failed, undefined, "no phase threw");
  assert.ok(line!.rows!.every((row) => typeof row.elapsedMs === "number"));
});

test("the root's supervision is a fleet pass of its own, timed to its end though it outlives the alarm's", async (context) => {
  const { clock, lines } = capture(context);
  const storage = new SlotMemory();
  const beside: Promise<unknown>[] = [];
  const ctx = {
    id: { toString: () => "a".repeat(64) },
    storage: Object.assign(storage, { getAlarm: async () => null, setAlarm: async () => {} }),
    waitUntil: (work: Promise<unknown>) => {
      beside.push(work);
    },
  };
  const env = {
    POOL_DATABASE_URL: "postgres://synthetic.invalid/pool",
    POOL_MANAGEMENT_KEY: "synthetic",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1".repeat(16),
    POOL_DEPLOYMENT_KEY: "e".repeat(64),
  };
  const code = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
  const handoff = new RuntimeHandoff(ctx as never, env, code, { wrap: (response) => response });
  let release!: () => void;
  let supervised = 0;
  handoff.supervise = () => {
    supervised++;
    return new Promise<void>((done) => {
      release = done;
    });
  };
  const fleet = new PoolRuntimeFleet({
    ctx: ctx as never,
    env,
    code,
    handoff,
    namespaces: () => [],
    provider: new RuntimeProviderReader("synthetic-read-token"),
    legacyPeers: {} as never,
    currentRequests: () => 0,
    wrap: (response) => response,
  });
  await fleet.upkeep();
  assert.equal(supervised, 1, "precondition: the fleet pass started the root's supervision");
  assert.deepEqual(
    lines().filter((line) => line.phase === "supervise"),
    [],
    "the fleet pass returned while supervision still ran",
  );
  clock.now = 1_200;
  release();
  await Promise.allSettled(beside);
  const supervise = lines().filter((line) => line.phase === "supervise");
  assert.deepEqual(
    supervise.map(({ side, outcome, elapsedMs, phases }) => ({ side, outcome, elapsedMs, phases })),
    [{ side: "fleet", outcome: "ended", elapsedMs: 1_200, phases: {} }],
  );
});
