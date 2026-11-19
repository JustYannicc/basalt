import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import { unservingBoundMs } from "./runtime-slots/unserving-clock.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;

async function root(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  context.mock.method(console, "info", () => {});
  const errors = context.mock.method(console, "error", () => {});
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  return {
    f,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    forcedStops: () =>
      errors.mock.calls.filter((call) => call.arguments[0] === "POOL_RUNTIME_FORCED_STOP").length,
    lines: () =>
      errors.mock.calls
        .map((call) =>
          call.arguments
            .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
            .join(" "),
        )
        .filter((line) => !/^POOL_(RUNTIME_ENDPOINT_FAILURE|SELECTED_RECOVERY_PENDING)/u.test(line))
        .slice(-16)
        .join("\n"),
  };
}
async function pass(f: Fixture) {
  await f.upkeep();
  await f.settle();
}
/** Reads the whole answer, so its stream lease is released before the next pass. */
async function serves(f: Fixture) {
  const response = await f.model();
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return true;
}
/** Readiness refuses for the current boot only, as a runtime that went bad and stays bad. */
function refuseCurrentBoot(f: Fixture) {
  const boot = f.old.identity().bootId;
  f.old.hooks.health = async () =>
    f.old.identity().bootId === boot ? new Response(null, { status: 503 }) : undefined;
  return boot;
}

test(
  "a root that refuses while its container keeps running is restarted and serving within the bound",
  { timeout: 20_000 },
  async (context) => {
    const { f, advance, forcedStops } = await root(context);
    const boot = refuseCurrentBoot(f);
    for (let elapsed = 0; elapsed < unservingBoundMs; elapsed += 2_000) {
      await pass(f);
      advance(2_000);
    }
    assert.deepEqual(f.old.calls.signals, [], "not stopped before the bound");
    assert.equal(f.old.ctx.container.running, true);
    await pass(f);
    assert.deepEqual(f.old.calls.signals, [15], "a graceful stop, never a hard one first");
    assert.equal(forcedStops(), 1);
    assert.equal(f.old.calls.destroy, 0);
    assert.equal(f.old.calls.start, 1);
    assert.notEqual(f.old.identity().bootId, boot);
    assert.equal(await serves(f), true);
  },
);

test("a 30-second readiness blip causes no restart", { timeout: 20_000 }, async (context) => {
  const { f, advance, forcedStops, lines } = await root(context);
  refuseCurrentBoot(f);
  for (let elapsed = 0; elapsed <= 30_000; elapsed += 2_000) {
    await pass(f);
    advance(2_000);
  }
  f.old.hooks.health = async () => {};
  for (let elapsed = 0; elapsed <= unservingBoundMs * 2; elapsed += 2_000) {
    await pass(f);
    advance(2_000);
  }
  // The same runtime answers again; its pool's membership renews through Home upkeep separately.
  const health = await f.command("active-health");
  assert.equal(health.status, 200, `${await health.clone().text()}\n${lines()}`);
  await health.body?.cancel();
  assert.deepEqual(f.old.calls.signals, []);
  assert.equal(forcedStops(), 0);
  assert.equal(f.old.calls.start, 0);
});

test(
  "SIGTERM is never sent while a token refresh is in flight (twenty restarts)",
  { timeout: 60_000 },
  async (context) => {
    const { f, advance, forcedStops, lines } = await root(context);
    let inFlight = false;
    context.mock.method(runtimeStopTiming, "refreshInFlight", async () => inFlight);
    const signal = f.old.ctx.container.signal.bind(f.old.ctx.container);
    const sent: boolean[] = [];
    f.old.ctx.container.signal = (number) => {
      sent.push(inFlight);
      signal(number);
    };
    for (let run = 0; run < 20; run++) {
      const boot = refuseCurrentBoot(f);
      await pass(f);
      advance(unservingBoundMs);
      // The refresh lasts zero to three passes, then completes.
      let remaining = (run * 7) % 4;
      for (let attempt = 0; attempt < 8 && f.old.identity().bootId === boot; attempt++) {
        inFlight = remaining-- > 0;
        await pass(f);
        advance(2_000);
      }
      assert.notEqual(f.old.identity().bootId, boot, `run ${run} restarted\n${lines()}`);
      assert.equal(await serves(f), true);
      // Past both hourly limits, the controller's and the container object's.
      advance(3_600_000 + 1);
    }
    assert.equal(sent.length, 20);
    assert.deepEqual(
      sent.filter((during) => during),
      [],
      "no signal during a refresh",
    );
    assert.equal(forcedStops(), 20);
  },
);

test(
  "a SIGTERM that doesn't stop the container within its grace ends in a recorded hard stop",
  { timeout: 20_000 },
  async (context) => {
    const { f, advance, forcedStops } = await root(context);
    f.old.ctx.container.signal = () => {};
    refuseCurrentBoot(f);
    await pass(f);
    advance(unservingBoundMs);
    await pass(f);
    assert.equal(f.old.calls.destroy, 1);
    assert.equal(forcedStops(), 1);
    assert.equal(f.old.calls.start, 1);
    assert.equal(await serves(f), true);
  },
);

test(
  "a container that reads as not running for a moment is never restarted over",
  { timeout: 20_000 },
  async (context) => {
    const { f } = await root(context);
    const before = f.old.identity();
    // 19 Nov 2026: `running` read false for under a second while the old container lived.
    context.mock.method(runtimeStopTiming, "confirmExit", async () => {
      f.old.revive();
    });
    f.old.crash();
    await pass(f);
    assert.equal(f.old.ctx.container.running, true);
    assert.equal(f.old.calls.start, 0, "no restart admitted over the running container");
    await pass(f);
    assert.equal(f.old.identity().bootId, before.bootId);
    const health = await f.command("active-health");
    assert.equal(health.status, 200, await health.clone().text());
    await health.body?.cancel();
    assert.equal(await serves(f), true);
  },
);
