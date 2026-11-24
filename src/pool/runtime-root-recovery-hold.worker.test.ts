import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { PoolAlarms } from "./alarms.ts";
import { runtimeAdmissionWaitMs, runtimeRetryTiming } from "./runtime-fleet/retry.ts";
import { restartStartBoundMs, unservingBoundMs } from "./runtime-slots/forced-restart-timing.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Call {
  id: string;
  at: number;
  settledAt?: number;
  response?: Response;
  error?: unknown;
}

/**
 * The controller's clock and the calls' clock are one: Date.now, the retry's own reads and its
 * pauses. A paused call sleeps until the test moves the clock past its wake-up, never in real time.
 */
async function rootUnderRecovery(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const sleepers = new Set<{ at: number; wake(): void }>();
  const pauses: number[] = [];
  const real = { ...runtimeRetryTiming };
  runtimeRetryTiming.now = () => now;
  runtimeRetryTiming.pause = (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      pauses.push(milliseconds);
      const sleeper = { at: now + milliseconds, wake: resolve };
      sleepers.add(sleeper);
      signal.addEventListener(
        "abort",
        () => {
          sleepers.delete(sleeper);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const logs = context.mock.method(console, "info", () => {});
  const errors = context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const f = await fleetWorkerFixture();
  const calls: Call[] = [];
  // A call still held when a test fails ends by its own bound before the fixture closes its
  // storage. Not by an abort: in Node a copied Request follows its parent's signal weakly, so a
  // collected copy can leave the abort unheard.
  const held = () => calls.some((call) => call.settledAt === undefined);
  context.after(async () => {
    now += 24 * 3_600_000;
    for (let turn = 0; turn < 20_000 && held(); turn++) {
      for (const sleeper of sleepers) sleeper.wake();
      sleepers.clear();
      await new Promise(setImmediate);
    }
  });
  context.after(f.cleanup);
  context.after(() => Object.assign(runtimeRetryTiming, real));
  await f.bootstrap();
  // Home has read the pool's membership before the outage, as it does every few seconds, so
  // admission keeps its authority while the root's Home is down.
  await new PoolAlarms(f.old.storage).schedule("home", Date.now());
  await f.alarm();
  await f.settle();
  const served = new Map<string, number>();
  f.onModel(async (_instance, request) => {
    const id = new URL(request.url).searchParams.get("proof")!;
    served.set(id, (served.get(id) ?? 0) + 1);
    return new Response(`ok:${id}`);
  });
  /**
   * Every call is answered or asleep in its pause, so moving the clock is all that is left. A call
   * may first join a recovery pass, which takes the fixture about half a second.
   */
  const idle = async () => {
    for (let turn = 0; turn < 200_000; turn++) {
      if (calls.filter((call) => call.settledAt === undefined).length === sleepers.size) return;
      await new Promise(setImmediate);
    }
    throw new Error("a call neither answered nor paused");
  };
  const advance = async (to: number) => {
    while (now < to) {
      now = Math.min(to, ...[...sleepers].map((sleeper) => sleeper.at));
      for (const sleeper of [...sleepers].filter((sleeper) => sleeper.at <= now)) {
        sleepers.delete(sleeper);
        sleeper.wake();
      }
      await idle();
    }
  };
  return {
    f,
    calls,
    served,
    pauses,
    now: () => now,
    advance,
    idle,
    call: (id: string) => {
      const call: Call = { id, at: now };
      calls.push(call);
      void f
        .model(
          new Request(`http://pool/v1/responses?proof=${id}`, {
            method: "POST",
            body: JSON.stringify({ model: "synthetic", input: "test" }),
            headers: { "content-type": "application/json" },
          }),
        )
        .then(
          (response) => {
            call.response = response;
          },
          (error: unknown) => {
            call.error = error;
          },
        )
        .finally(() => {
          call.settledAt = now;
        });
    },
    phases: () =>
      logs.mock.calls
        .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY")
        .map((call) => call.arguments[1] as { phase: string; at: number }),
    pending: () =>
      errors.mock.calls
        .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY_PENDING")
        .map((call) => JSON.parse(String(call.arguments[1])) as Record<string, unknown>),
  };
}

async function pass(f: Fixture) {
  await f.upkeep();
  await f.settle();
}

test(
  "tonight: every call that arrives while the root restarts is held and served, none answered with an error",
  { timeout: 30_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    const detected = root.now();
    const taken = f.old.identity().bootId;
    // The platform has no container instance to give until 22 s into the recovery.
    const start = f.old.ctx.container.start.bind(f.old.ctx.container);
    f.old.ctx.container.start = (options) => {
      if (root.now() < detected + 22_000) throw new Error("synthetic: no container instance");
      start(options);
    };
    // The new boot comes up slowly: its readiness answers 50 s into the recovery.
    const up = deferred();
    f.old.hooks.health = async () => {
      if (f.old.calls.start) await up.promise;
    };
    f.old.crash();
    await pass(f);
    for (const [at, step] of [
      [1_000, () => root.call("1s")],
      [6_000, () => pass(f)],
      [10_000, () => root.call("10s")],
      [12_000, () => pass(f)],
      // The fourth start gets an instance; its pass waits on the new boot's readiness.
      [22_000, () => f.upkeep()],
      [30_000, () => root.call("30s")],
      [45_000, () => root.call("45s")],
    ] as const) {
      await root.advance(detected + at);
      await step();
      await root.idle();
    }
    await root.advance(detected + 50_000);
    up.resolve();
    await f.settle();
    await root.advance(detected + 52_000);

    const pending = root.pending();
    assert.equal(pending.length, 3, "three start rounds found no container");
    for (const line of pending)
      assert.deepEqual(
        { reason: line.reason, step: line.step, class: line.class },
        { reason: "transport", step: "endpoint_route", class: "RemoteRuntimeDefect" },
      );
    const phases = root.phases();
    assert.equal(phases.filter((row) => row.phase === "starting").length, 4);
    assert.equal(phases.find((row) => row.phase === "detected")?.at, detected);
    assert.equal(phases.find((row) => row.phase === "ready")?.at, detected + 50_000);
    for (const call of root.calls) {
      assert.equal(call.error, undefined, `${call.id}: ${String(call.error)}`);
      assert.equal(call.response?.status, 200, `${call.id} was answered with an error`);
      assert.equal(await call.response!.text(), `ok:${call.id}`);
      assert.equal(root.served.get(call.id), 1, `${call.id} ran once`);
      assert.ok(call.settledAt! <= detected + 51_000, `${call.id} served within a pacing step`);
    }
    assert.equal(root.calls.length, 4);
    assert.ok(
      root.pauses.every((pause) => pause > 0 && pause <= 1_000),
      "paced like admission",
    );
    assert.equal(f.old.calls.start, 1, "one start got an instance");
    assert.notEqual(f.old.identity().bootId, taken, "the calls ran on the new boot");
  },
);

test(
  "a root recovery that never completes answers a held call with the retryable 503 at its bound",
  { timeout: 30_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    const detected = root.now();
    f.old.ctx.container.start = () => {
      throw new Error("synthetic: no container instance");
    };
    f.old.crash();
    await pass(f);
    await root.advance(detected + 1_000);
    root.call("held");
    await root.idle();
    // Recovery keeps trying, and never gets an instance.
    for (let at = 20_000; at <= restartStartBoundMs + 20_000; at += 20_000) {
      await root.advance(detected + at);
      await pass(f);
      await root.idle();
    }
    const [call] = root.calls;
    assert.equal(call?.error, undefined);
    assert.equal(call?.response?.status, 503);
    assert.equal(call?.response?.headers.get("Retry-After"), "1");
    await call?.response?.body?.cancel();
    const waited = call!.settledAt! - detected;
    assert.ok(
      waited >= restartStartBoundMs && waited <= restartStartBoundMs + 1_000,
      `answered ${waited} ms after detection`,
    );
    assert.equal(root.served.size, 0);
  },
);

test(
  "a controller reset mid-recovery keeps the hold's bound from the first detection",
  { timeout: 30_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    const detected = root.now();
    f.old.ctx.container.start = () => {
      throw new Error("synthetic: no container instance");
    };
    f.old.crash();
    await pass(f);
    await root.advance(detected + 100_000);
    f.reconstruct();
    await pass(f);
    root.call("after-reset");
    await root.idle();
    for (let at = 120_000; at <= restartStartBoundMs + 20_000; at += 20_000) {
      await root.advance(detected + at);
      await pass(f);
      await root.idle();
    }
    const [call] = root.calls;
    assert.equal(call?.response?.status, 503, "answered at the bound, not held past it");
    await call?.response?.body?.cancel();
    const waited = call!.settledAt! - detected;
    assert.ok(
      waited >= restartStartBoundMs && waited <= restartStartBoundMs + 1_000,
      `answered ${waited} ms after the first detection`,
    );
  },
);

test(
  "an outage after the root served again is bounded from its own detection",
  { timeout: 30_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    const first = root.now();
    let instances = false;
    const start = f.old.ctx.container.start.bind(f.old.ctx.container);
    f.old.ctx.container.start = (options) => {
      if (!instances) throw new Error("synthetic: no container instance");
      start(options);
    };
    f.old.crash();
    await pass(f);
    await root.advance(first + 10_000);
    instances = true;
    await pass(f);
    assert.ok(root.phases().some((row) => row.phase === "ready" && row.at === first + 10_000));
    await root.advance(first + 100_000);
    instances = false;
    const second = root.now();
    f.old.crash();
    await pass(f);
    await root.advance(second + 1_000);
    root.call("second-outage");
    await root.idle();
    for (let at = 20_000; at <= restartStartBoundMs + 20_000; at += 20_000) {
      await root.advance(second + at);
      await pass(f);
      await root.idle();
    }
    const [call] = root.calls;
    assert.equal(call?.response?.status, 503);
    await call?.response?.body?.cancel();
    const waited = call!.settledAt! - second;
    assert.ok(
      waited >= restartStartBoundMs && waited <= restartStartBoundMs + 1_000,
      `answered ${waited} ms after the second detection`,
    );
  },
);

/** Readiness refuses for the current boot only, as a runtime that went bad and stays bad. */
function refuseCurrentBoot(f: Fixture) {
  const boot = f.old.identity().bootId;
  f.old.hooks.health = async () =>
    f.old.identity().bootId === boot ? new Response(null, { status: 503 }) : undefined;
  return boot;
}

/** A call that arrives now on a recovery that can't progress gets today's 30 s, as passes go on. */
async function answeredAsToday(root: Awaited<ReturnType<typeof rootUnderRecovery>>) {
  const arrived = root.now();
  root.call("stalled");
  await root.idle();
  for (let at = 10_000; at <= runtimeAdmissionWaitMs + 10_000; at += 10_000) {
    await root.advance(arrived + at);
    await pass(root.f);
    await root.idle();
  }
  const [call] = root.calls;
  assert.equal(call?.response?.status, 503, "not held");
  assert.equal(call.response.headers.get("Retry-After"), "1");
  await call.response.body?.cancel();
  const waited = call.settledAt! - arrived;
  assert.ok(
    waited >= runtimeAdmissionWaitMs && waited <= runtimeAdmissionWaitMs + 1_000,
    `answered after ${waited} ms`,
  );
}

test(
  "a recovery that needs a person after a failed stop holds no call",
  { timeout: 30_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    f.old.ctx.container.signal = () => {};
    f.old.ctx.container.destroy = async () => {
      throw new Error("synthetic destroy failure");
    };
    refuseCurrentBoot(f);
    const detected = root.now();
    await pass(f);
    await root.advance(detected + unservingBoundMs);
    await pass(f);
    const { recovery } = (await f.send("inspect")) as { recovery: { needsPerson?: unknown } };
    assert.deepEqual(recovery.needsPerson, {
      at: detected + unservingBoundMs,
      reason: "stop_failed",
    });
    await answeredAsToday(root);
  },
);

test(
  "a recovery at its hourly forced-restart limit holds no call",
  { timeout: 30_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    f.old.hooks.sigtermExits = true;
    for (let restart = 0; restart < 3; restart++) {
      const boot = refuseCurrentBoot(f);
      await pass(f);
      await root.advance(root.now() + unservingBoundMs);
      for (let attempt = 0; attempt < 8 && f.old.identity().bootId === boot; attempt++) {
        await pass(f);
        await root.advance(root.now() + 2_000);
      }
      assert.notEqual(f.old.identity().bootId, boot, `forced restart ${restart + 1}`);
      await pass(f);
    }
    refuseCurrentBoot(f);
    await pass(f);
    await root.advance(root.now() + unservingBoundMs);
    await pass(f);
    const { recovery } = (await f.send("inspect")) as {
      recovery: { needsPerson?: { reason: string } };
    };
    assert.equal(recovery.needsPerson?.reason, "restart_limit");
    await answeredAsToday(root);
  },
);

test(
  "a recovery whose provider credential is missing holds no call",
  { timeout: 60_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    f.secretAvailable(false);
    f.old.crash();
    await pass(f);
    assert.equal(f.old.calls.start, 0, "no restart without a provider observation");
    await answeredAsToday(root);
  },
);

test(
  "once the credential is back and a pass starts the root again, calls hold for the restart",
  { timeout: 60_000 },
  async (context) => {
    const root = await rootUnderRecovery(context);
    const { f } = root;
    f.secretAvailable(false);
    f.old.ctx.container.start = () => {
      throw new Error("synthetic: no container instance");
    };
    f.old.crash();
    const detected = root.now();
    await pass(f);
    f.secretAvailable(true);
    await root.advance(detected + 2_000);
    await pass(f);
    assert.equal(root.phases().filter((row) => row.phase === "starting").length, 1);
    root.call("held-again");
    await root.idle();
    for (let at = 10_000; at <= 60_000; at += 10_000) {
      await root.advance(detected + at);
      await pass(f);
      await root.idle();
    }
    assert.equal(root.calls[0]?.settledAt, undefined, "held past today's 30 s");
  },
);
