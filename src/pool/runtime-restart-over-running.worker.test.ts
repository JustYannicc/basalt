import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { runtimeRetryTiming } from "./runtime-fleet/retry.ts";
import {
  leakedStreamsMs,
  restartStartBoundMs,
  unservingBoundMs,
} from "./runtime-slots/forced-restart-timing.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Inspected {
  selection: { epoch: number; active: { identity: { bootId: string } } };
}
interface Witnessed {
  witness?: { operationId: string; bootId?: string };
}

async function passes(f: Fixture, count: number) {
  for (let pass = 0; pass < count; pass++) {
    await f.upkeep();
    await f.settle();
  }
}

/**
 * The stuck state: the root had been restarted by recovery before. Then one recovery pass
 * read its container as not running, admitted a restart and wrote that restart's launch witness,
 * but the old container was still there, so the start never produced a boot. From then on every
 * read refused identity while the old container kept running, and every pass joined that restart.
 */
async function stuckOverRunningContainer(f: Fixture) {
  await f.bootstrap();
  f.old.crash();
  await passes(f, 1);
  assert.equal(f.old.calls.start, 1, "an earlier recovery restart");
  const previous = f.old.identity();
  const epoch = ((await f.send("inspect")) as Inspected).selection.epoch;
  const start = f.old.ctx.container.start.bind(f.old.ctx.container);
  f.old.crash();
  const since = Date.now();
  f.old.ctx.container.start = () => {
    f.old.revive();
    throw new Error("synthetic: the previous container is still running");
  };
  await passes(f, 1);
  f.old.ctx.container.start = start;
  await passes(f, 3);
  return { previous, epoch, since };
}

/** The test's clock, moved only by the test and by a held call's own pauses. */
function testClock(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  return (milliseconds: number) => {
    now += milliseconds;
  };
}

async function assertStuck(
  f: Fixture,
  { previous, epoch, since }: Awaited<ReturnType<typeof stuckOverRunningContainer>>,
  advance: (milliseconds: number) => void,
) {
  assert.equal(f.old.ctx.container.running, true);
  assert.equal(f.old.identity().bootId, previous.bootId, "the old container still runs");
  const refused = await f.command("active-health");
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /runtime_endpoint_identity_slot_identity/u);
  const { witness } = (await f.send("witness", { target: f.old.target })) as Witnessed;
  assert.match(witness?.operationId ?? "", /^restart-/u);
  assert.equal(witness?.bootId, undefined, "the admitted restart never recorded a boot");
  const { selection } = (await f.send("inspect")) as Inspected;
  assert.equal(selection.epoch, epoch);
  assert.equal(selection.active.identity.bootId, previous.bootId);
  // A call holds for the restart recovery keeps joining, and gets the native retry advice once the
  // recovery's bound has passed. Its pauses move the test's clock, and no pass runs meanwhile.
  const pause = runtimeRetryTiming.pause;
  runtimeRetryTiming.pause = async (milliseconds) => advance(milliseconds);
  try {
    const model = await f.model();
    assert.equal(model.status, 503);
    assert.equal(model.headers.get("Retry-After") !== null, true);
    await model.body?.cancel();
  } finally {
    runtimeRetryTiming.pause = pause;
  }
  assert.ok(Date.now() - since >= restartStartBoundMs, "never before the recovery's bound");
}

async function assertHealed(f: Fixture, previous: { bootId: string }, epoch: number) {
  const installsBefore = f.old.calls.install.length;
  await passes(f, 3);
  assert.equal(f.old.ctx.container.running, true);
  assert.equal(f.old.calls.start, 2, "exactly one new start, for the admitted restart");
  const next = f.old.identity();
  assert.notEqual(next.bootId, previous.bootId);
  const { selection } = (await f.send("inspect")) as Inspected;
  assert.equal(selection.epoch, epoch + 1, "the joined restart committed the new boot");
  assert.equal(selection.active.identity.bootId, next.bootId);
  const { witness } = (await f.send("witness", { target: f.old.target })) as Witnessed;
  assert.equal(witness?.bootId, next.bootId);
  assert.ok(f.old.calls.install.length > installsBefore, "policies installed on the new boot");
  const health = await f.command("active-health");
  assert.equal(health.status, 200, await health.clone().text());
  await health.body?.cancel();
  const model = await f.model();
  assert.equal(model.status, 200);
  await model.body?.cancel();
}

for (const stop of ["graceful", "hard"] as const)
  test(
    `a restart admitted over a running container completes after a ${stop} stop`,
    { timeout: 20_000 },
    async (context) => {
      const advance = testClock(context);
      const f = await fleetWorkerFixture();
      context.after(f.cleanup);
      f.old.hooks.sigtermExits = stop === "graceful";
      const logs = context.mock.method(console, "info", () => {});
      context.mock.method(console, "error", () => {});
      const stuck = await stuckOverRunningContainer(f);
      const { previous, epoch } = stuck;
      await assertStuck(f, stuck, advance);
      const phases = logs.mock.calls
        .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY")
        .map((call) => (call.arguments[1] as { phase: string }).phase);
      assert.equal(phases.filter((phase) => phase === "authorizing").length, 2);
      assert.ok(phases.slice(-3).includes("starting"), "every stuck pass joins the restart");
      if (stop === "graceful") f.old.ctx.container.signal(15);
      else await f.old.ctx.container.destroy();
      await assertHealed(f, previous, epoch);
    },
  );

test(
  "the operator crash route refuses a root stuck over its admitted restart",
  { timeout: 20_000 },
  async (context) => {
    const advance = testClock(context);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "error", () => {});
    const stuck = await stuckOverRunningContainer(f);
    const { previous } = stuck;
    const at = Date.now();
    const crash = await f.command("runtime-crash", {
      identity: previous,
      nonce: crypto.randomUUID(),
      operator: "fixture-operator",
      at,
      expiresAt: at + 30_000,
    });
    assert.notEqual(crash.status, 200);
    await crash.body?.cancel();
    assert.deepEqual(f.old.calls.signals, []);
    await assertStuck(f, stuck, advance);
  },
);

test(
  "the stuck record heals by itself once it has refused for the bound, with a graceful stop",
  { timeout: 20_000 },
  async (context) => {
    const advance = testClock(context);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    f.old.hooks.sigtermExits = true;
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "error", () => {});
    const stuck = await stuckOverRunningContainer(f);
    const { previous, epoch } = stuck;
    await assertStuck(f, stuck, advance);
    assert.deepEqual(f.old.calls.signals, [], "never stopped before the bound");
    advance(unservingBoundMs);
    await assertHealed(f, previous, epoch);
    assert.deepEqual(f.old.calls.signals, [15]);
    assert.equal(f.old.calls.destroy, 0);
  },
);

test(
  "the stuck record heals by itself when its pool policy expired long ago",
  { timeout: 30_000 },
  async (context) => {
    const advance = testClock(context);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    context.mock.method(console, "info", () => {});
    const errors = context.mock.method(console, "error", () => {});
    const stuck = await stuckOverRunningContainer(f);
    const { previous, epoch } = stuck;
    // A pool policy that is clean but long expired: every install and Home call was refused.
    advance(3_600_000);
    // A release's new code first sees the refusal with a fresh clock.
    await f.send("recovery-reset", { operationId: "incident-release" });
    await passes(f, 1);
    await assertStuck(f, stuck, advance);
    advance(unservingBoundMs);
    try {
      await assertHealed(f, previous, epoch);
    } catch (error) {
      const lines = errors.mock.calls
        .map((call) =>
          call.arguments
            .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
            .join(" "),
        )
        .filter((line) => !line.startsWith("POOL_RUNTIME_ENDPOINT_FAILURE"))
        .slice(-20)
        .join("\n");
      throw new Error(`${String(error)}\n${lines}`, { cause: error });
    }
    assert.deepEqual(f.old.calls.signals, [15]);
  },
);

test(
  "the stuck record heals after a held stream count, with no needs-a-person",
  { timeout: 30_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "error", () => {});
    const { previous, epoch } = await stuckOverRunningContainer(f);
    // A lease that never moves, unstamped: the stop waits leakedStreamsMs from the first refusal,
    // exactly the restart budget, while every pass also joins the restart admitted over it.
    const identity = f.old.identity();
    await f.old.storage.put(
      `runtime-activity-v1:${JSON.stringify([identity.slotId, identity.bootId])}`,
      { identity, phase: "open", active: 1, known: true, leases: { leaked: "active" } },
    );
    now += 3_600_000;
    await f.send("recovery-reset", { operationId: "incident-release" });
    for (let elapsed = 0; elapsed < leakedStreamsMs; elapsed += 10_000) {
      await passes(f, 1);
      now += 10_000;
    }
    assert.deepEqual(f.old.calls.signals, [], "held while the count may be live");
    now += 10_000;
    await assertHealed(f, previous, epoch);
    const { recovery } = (await f.send("inspect")) as { recovery: { needsPerson?: unknown } };
    assert.equal(recovery.needsPerson, undefined);
    assert.deepEqual(f.old.calls.signals, [15]);
  },
);

for (const [answer, readiness] of [
  ["503", async () => new Response(null, { status: 503 })],
  ["a refused connection", async () => Promise.reject(new TypeError("connection refused"))],
  ["no answer in time", () => new Promise<Response>(() => {})],
] as const)
  test(
    `the stuck record heals when the old container answers readiness with ${answer}`,
    { timeout: 30_000 },
    async (context) => {
      const advance = testClock(context);
      const f = await fleetWorkerFixture();
      context.after(f.cleanup);
      context.mock.method(console, "info", () => {});
      context.mock.method(console, "error", () => {});
      const stuck = await stuckOverRunningContainer(f);
      const { previous, epoch } = stuck;
      f.old.hooks.health = async () =>
        f.old.identity().bootId === previous.bootId ? readiness() : undefined;
      // Hours later, past any start the admitted restart could still have in progress.
      advance(3_600_000);
      await f.send("recovery-reset", { operationId: "incident-release" });
      await passes(f, 1);
      await assertStuck(f, stuck, advance);
      advance(unservingBoundMs);
      await assertHealed(f, previous, epoch);
      assert.deepEqual(f.old.calls.signals, [15]);
    },
  );
