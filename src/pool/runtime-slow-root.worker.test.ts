import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { policyHealthHeader } from "./runtime-health.ts";
import { runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import {
  aliveRefusingMs,
  servingReadMs,
  unservingBoundMs,
} from "./runtime-slots/forced-restart-timing.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;

/**
 * The root under the controller's own recovery, endpoint and readiness reads. Only the clock the
 * recovery counts on moves by hand; a read's own deadlines run in real time.
 */
async function root(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  context.mock.method(runtimeStopTiming, "stopGrace", async () => {});
  context.mock.method(runtimeStopTiming, "confirmExit", async () => {});
  const infos = context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  f.old.hooks.sigtermExits = true;
  await f.bootstrap();
  const lines = (name: string) =>
    infos.mock.calls.filter((call) => call.arguments[0] === name).map((call) => call.arguments[1]);
  return {
    f,
    boot: f.old.identity().bootId,
    now: () => now,
    pass: async (at: number) => {
      now = at;
      await f.upkeep();
      await f.settle();
    },
    spared: () =>
      lines("POOL_RUNTIME_STOP_SPARED").map(
        (line) => JSON.parse(String(line)) as { answeredMs: number; refusingMs: number },
      ),
    phases: () => lines("POOL_SELECTED_RECOVERY").map((line) => (line as { phase: string }).phase),
  };
}

/** The selected boot answers health again; its pool's membership renews through Home upkeep. */
async function answersHealth(f: Fixture) {
  const health = await f.command("active-health");
  assert.equal(health.status, 200, await health.clone().text());
  await health.body?.cancel();
}
/** The old boot answers ready only after the lease it reports ran out: slow, alive. */
function answerLate(f: Fixture, boot: string) {
  f.old.hooks.health = async () => {
    const late = f.old.identity().bootId === boot;
    f.old.hooks.readinessLeaseMs = late ? 1 : 1_500;
    if (late) await sleep(5);
  };
}
function answerOnTime(f: Fixture) {
  f.old.hooks.health = async () => {};
  f.old.hooks.readinessLeaseMs = 1_500;
}

test(
  "a root whose readiness answers ready for its boot only after 1.6 s is not stopped",
  { timeout: 30_000 },
  async (context) => {
    const r = await root(context);
    r.f.old.hooks.health = async () => {
      if (r.f.old.identity().bootId === r.boot) await sleep(1_600);
    };
    const start = r.now();
    // The warm read gives up at its 1.5 s lease window, so the recovery's bound starts.
    await r.pass(start);
    await r.pass(start + unservingBoundMs);
    assert.deepEqual(r.f.old.calls.signals, [], "a late ready answer is not a dead root");
    assert.equal(r.f.old.ctx.container.running, true);
    const [spare] = r.spared();
    assert.ok(spare && spare.answeredMs >= 1_600 && spare.answeredMs < servingReadMs);
    answerOnTime(r.f);
    await r.pass(start + unservingBoundMs + 2_000);
    await answersHealth(r.f);
    assert.equal(r.f.old.identity().bootId, r.boot, "the same boot serves again");
  },
);

test(
  "a root that answers ready late for 110 s is never stopped, is read once in that time, and serves again on its boot",
  { timeout: 60_000 },
  async (context) => {
    const r = await root(context);
    answerLate(r.f, r.boot);
    const start = r.now();
    for (let at = 0; at <= 110_000; at += 2_000) await r.pass(start + at);
    assert.deepEqual(r.f.old.calls.signals, []);
    assert.deepEqual(
      r.spared().map((spare) => spare.refusingMs),
      [unservingBoundMs],
      "one liveness read a bound, not one a pass",
    );
    answerOnTime(r.f);
    await r.pass(start + 112_000);
    await answersHealth(r.f);
    assert.equal(r.f.old.identity().bootId, r.boot);
  },
);

test(
  "a root that answers ready late forever is stopped at the first pass from aliveRefusingMs, then restarts",
  { timeout: 60_000 },
  async (context) => {
    const r = await root(context);
    answerLate(r.f, r.boot);
    const start = r.now();
    // Eleven seconds apart, so the read a bound after the spare would come only after the limit.
    let at = 0;
    for (; at < aliveRefusingMs; at += 11_000) await r.pass(start + at);
    assert.deepEqual(r.f.old.calls.signals, [], "not stopped before aliveRefusingMs");
    assert.deepEqual(
      r.spared().map((spare) => spare.refusingMs),
      [66_000],
    );
    await r.pass(start + at);
    assert.equal(at, 121_000);
    assert.deepEqual(r.f.old.calls.signals, [15], "stopped at the first pass past the limit");
    for (let next = at + 2_000; next <= at + 20_000; next += 2_000) await r.pass(start + next);
    assert.ok(r.phases().includes("stopped"));
    assert.equal(r.phases().at(-1), "ready");
    assert.notEqual(r.f.old.identity().bootId, r.boot, "a new boot serves");
  },
);

test(
  "a root that answers ready in time while its warm read refuses is never stopped and read once a bound, past aliveRefusingMs too",
  { timeout: 60_000 },
  async (context) => {
    const r = await root(context);
    // Readiness is on time; keeping the container awake fails, so every warm read refuses.
    r.f.old.hooks.keepAlive = async () => {
      throw new Error("synthetic: inactivity timeout refused");
    };
    const start = r.now();
    for (let at = 0; at <= 420_000; at += 2_000) await r.pass(start + at);
    assert.deepEqual(r.f.old.calls.signals, []);
    assert.deepEqual(
      r.spared().map((spare) => spare.refusingMs),
      [1, 2, 3, 4, 5, 6, 7].map((bounds) => bounds * unservingBoundMs),
    );
  },
);

/** Guards: a root that can't answer ready is stopped at the bound, before and after this change. */
async function stoppedAtTheBound(
  context: TestContext,
  readiness: (f: Fixture, boot: string) => () => Promise<Response | void>,
) {
  const r = await root(context);
  r.f.old.hooks.health = readiness(r.f, r.boot);
  const start = r.now();
  await r.pass(start);
  await r.pass(start + unservingBoundMs - 2_000);
  assert.deepEqual(r.f.old.calls.signals, [], "not before the bound");
  await r.pass(start + unservingBoundMs);
  assert.deepEqual(r.f.old.calls.signals, [15], "stopped at the bound");
  assert.deepEqual(r.spared(), []);
}

test("a root whose readiness answers 503 is stopped at the bound", { timeout: 30_000 }, (context) =>
  stoppedAtTheBound(
    context,
    (f, boot) => async () =>
      f.old.identity().bootId === boot ? new Response(null, { status: 503 }) : undefined,
  ),
);

test(
  "a root whose readiness never answers is stopped at the bound, after its liveness read gives up",
  { timeout: 60_000 },
  (context) =>
    stoppedAtTheBound(
      context,
      (f, boot) => () =>
        f.old.identity().bootId === boot ? new Promise<never>(() => {}) : Promise.resolve(),
    ),
);

test(
  "a root whose readiness answers ready for another boot is stopped at the bound",
  { timeout: 30_000 },
  (context) =>
    stoppedAtTheBound(
      context,
      (f, boot) => async () =>
        f.old.identity().bootId === boot
          ? Response.json(
              { boot_id: "another-boot", started_at: "fixture-started" },
              { headers: { [policyHealthHeader]: "1500" } },
            )
          : undefined,
    ),
);
