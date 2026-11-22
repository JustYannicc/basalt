import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import {
  forcedRestartBudgetMs,
  leakedStreamsMs,
  unservingBoundMs,
} from "./runtime-slots/forced-restart-timing.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;

async function root(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const infos = context.mock.method(console, "info", () => {});
  const errors = context.mock.method(console, "error", () => {});
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  return {
    f,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    phases: () =>
      infos.mock.calls
        .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY")
        .map((call) => (call.arguments[1] as { phase: string }).phase),
    forcedStops: () =>
      errors.mock.calls.filter((call) => call.arguments[0] === "POOL_RUNTIME_FORCED_STOP").length,
    stopPaths: () =>
      errors.mock.calls
        .filter((call) => call.arguments[0] === "POOL_RUNTIME_FORCED_STOP")
        .map((call) => (JSON.parse(String(call.arguments[1])) as { path: string }).path),
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
    const { f, advance, forcedStops, stopPaths } = await root(context);
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
    assert.deepEqual(stopPaths(), ["graceful_exit"]);
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
    const { f, advance, forcedStops, stopPaths } = await root(context);
    f.old.ctx.container.signal = () => {};
    refuseCurrentBoot(f);
    await pass(f);
    advance(unservingBoundMs);
    await pass(f);
    assert.equal(f.old.calls.destroy, 1);
    assert.equal(forcedStops(), 1);
    assert.deepEqual(stopPaths(), ["destroy_after_grace"]);
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
    // `running` reads false for a moment while the old container lives.
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

async function recoveryState(f: Fixture) {
  return ((await f.send("inspect")) as { recovery: { needsPerson?: { reason: string } } }).recovery;
}

test(
  "a restart's own new boot that hasn't committed within the bound is never stopped",
  { timeout: 60_000 },
  async (context) => {
    const { f, advance } = await root(context);
    let failing = true;
    f.old.hooks.install = async () => {
      if (failing) throw new Error("synthetic install failure");
    };
    f.old.crash();
    for (let elapsed = 0; elapsed <= unservingBoundMs * 2; elapsed += 2_000) {
      await pass(f);
      advance(2_000);
    }
    assert.deepEqual(f.old.calls.signals, [], "the new boot is the restart's own");
    assert.equal(f.old.calls.start, 1);
    failing = false;
    await pass(f);
    await pass(f);
    assert.equal(await serves(f), true);
    assert.equal(f.old.calls.start, 1);
  },
);

test(
  "a slow but healthy forced restart that commits after 120 s passes untouched",
  { timeout: 60_000 },
  async (context) => {
    const { f, advance, stopPaths } = await root(context);
    const old = refuseCurrentBoot(f);
    let stoppedAt: number | undefined;
    // The new boot answers, but its pre-commit steps take 120 s, as a cold start's can.
    f.old.hooks.install = async () => {
      if (f.old.identity().bootId === old) return;
      stoppedAt ??= Date.now();
      if (Date.now() - stoppedAt < 120_000) throw new Error("synthetic: not ready yet");
    };
    await pass(f);
    advance(unservingBoundMs);
    await pass(f);
    for (let elapsed = 0; elapsed <= 130_000; elapsed += 2_000) {
      await pass(f);
      advance(2_000);
    }
    assert.deepEqual(stopPaths(), ["graceful_exit"], "one stop, of the old boot only");
    assert.equal(f.old.calls.start, 1);
    assert.equal(await serves(f), true);
  },
);

test(
  "a forced restart whose new boot never commits ends in needs-a-person, not a loop of stops",
  { timeout: 60_000 },
  async (context) => {
    const { f, advance } = await root(context);
    const old = refuseCurrentBoot(f);
    f.old.hooks.install = async () => {
      if (f.old.identity().bootId !== old) throw new Error("synthetic install failure");
    };
    await pass(f);
    advance(unservingBoundMs);
    await pass(f);
    assert.deepEqual(f.old.calls.signals, [15]);
    // Past the whole restart budget, which follows the stop grace.
    for (let elapsed = 0; elapsed <= forcedRestartBudgetMs + 6_000; elapsed += 2_000) {
      await pass(f);
      advance(2_000);
    }
    assert.deepEqual(f.old.calls.signals, [15], "the restart's own boot is never stopped");
    assert.equal((await recoveryState(f)).needsPerson?.reason, "restart_failed");
  },
);

test(
  "a forced restart that commits but never reaches ready ends in needs-a-person",
  { timeout: 60_000 },
  async (context) => {
    const { f, advance, phases } = await root(context);
    refuseCurrentBoot(f);
    // Installs after the restart attested fail: the commit lands, its final proof never passes.
    f.old.hooks.install = async () => {
      if (phases().includes("attesting")) throw new Error("synthetic post-commit failure");
    };
    await pass(f);
    advance(unservingBoundMs);
    for (let elapsed = 0; elapsed <= forcedRestartBudgetMs + 30_000; elapsed += 30_000) {
      await pass(f);
      advance(30_000);
    }
    assert.deepEqual(f.old.calls.signals, [15]);
    assert.equal(f.old.calls.start, 1);
    assert.ok(!phases().includes("ready"), "the restart never reported ready");
    assert.equal((await recoveryState(f)).needsPerson?.reason, "restart_failed");
  },
);

test(
  "no launch witness is written when the container reads running again before the start",
  { timeout: 20_000 },
  async (context) => {
    const { f } = await root(context);
    let confirmations = 0;
    // Admission sees a confirmed stop; the start's own confirmation sees the container again.
    context.mock.method(runtimeStopTiming, "confirmExit", async () => {
      if (++confirmations === 2) f.old.revive();
    });
    f.old.crash();
    await pass(f);
    assert.equal(confirmations, 2);
    assert.equal(f.old.calls.start, 0);
    const { witness } = (await f.send("witness", { target: f.old.target })) as {
      witness?: unknown;
    };
    assert.equal(witness, undefined, "no launch witness over the running container");
  },
);

test(
  "a stop that fails records needs-a-person instead of trying again",
  { timeout: 20_000 },
  async (context) => {
    const { f, advance, stopPaths } = await root(context);
    f.old.ctx.container.signal = () => {};
    f.old.ctx.container.destroy = async () => {
      throw new Error("synthetic destroy failure");
    };
    refuseCurrentBoot(f);
    await pass(f);
    advance(unservingBoundMs);
    await pass(f);
    assert.deepEqual(stopPaths(), ["stop_failed"]);
    assert.equal((await recoveryState(f)).needsPerson?.reason, "stop_failed");
    advance(unservingBoundMs);
    await pass(f);
    assert.deepEqual(stopPaths(), ["stop_failed"], "no second stop after a failed one");
  },
);

test(
  "a moment's not-running read never turns a held stop into needs-a-person",
  { timeout: 30_000 },
  async (context) => {
    const { f, advance, stopPaths } = await root(context);
    const identity = f.old.identity();
    await f.old.storage.put(
      `runtime-activity-v1:${JSON.stringify([identity.slotId, identity.bootId])}`,
      { identity, phase: "open", active: 1, known: true, leases: { leaked: "active" } },
    );
    refuseCurrentBoot(f);
    // The first pass reads the container as not running; it lives, so no restart is admitted.
    let blip = true;
    context.mock.method(runtimeStopTiming, "confirmExit", async () => {
      if (blip) f.old.revive();
    });
    f.old.crash();
    await pass(f);
    blip = false;
    assert.equal(f.old.calls.start, 0);
    for (let elapsed = 0; elapsed <= leakedStreamsMs; elapsed += 10_000) {
      advance(10_000);
      await pass(f);
    }
    assert.deepEqual(stopPaths(), ["graceful_exit"], "stopped once the count stood still");
    await pass(f);
    assert.equal(await serves(f), true);
    assert.equal((await recoveryState(f)).needsPerson, undefined);
  },
);

test(
  "a stream count that stands still holds the stop for leakedStreamsMs from the first refusal, visibly",
  { timeout: 60_000 },
  async (context) => {
    const { f, advance, stopPaths, phases } = await root(context);
    // A lease an earlier isolate never released, from before this code stamped changes: the
    // count reads 1 and never moves, as a live long turn would.
    const identity = f.old.identity();
    await f.old.storage.put(
      `runtime-activity-v1:${JSON.stringify([identity.slotId, identity.bootId])}`,
      { identity, phase: "open", active: 1, known: true, leases: { leaked: "active" } },
    );
    refuseCurrentBoot(f);
    const firstRefusal = Date.now();
    for (let elapsed = 0; elapsed < leakedStreamsMs; elapsed += 10_000) {
      await pass(f);
      advance(10_000);
    }
    assert.deepEqual(stopPaths(), [], "held while the count may still be live");
    assert.ok(phases().includes("waiting_for_streams"));
    const { recovery } = (await f.send("inspect")) as {
      recovery: { streams?: { active: number; stillSince: number } };
    };
    assert.equal(recovery.streams?.active, 1);
    assert.ok(
      (recovery.streams?.stillSince ?? 0) >= firstRefusal,
      "counted from the first refusal",
    );
    advance(10_000);
    await pass(f);
    assert.deepEqual(stopPaths(), ["graceful_exit"]);
    await pass(f);
    assert.equal(await serves(f), true);
  },
);
