import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { policyHealthHeader } from "./runtime-health.ts";
import {
  aliveRefusingMs,
  leakedStreamsMs,
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
  const waiters: { name: string; match(fields: unknown): boolean; heard(): void }[] = [];
  const heard = (name: unknown, fields?: unknown) => {
    for (const waiter of waiters.filter((one) => one.name === name && one.match(fields))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.heard();
    }
  };
  const infos = context.mock.method(console, "info", heard);
  context.mock.method(console, "error", heard);
  context.mock.method(console, "warn", () => {});
  /** The next line of this name the controller logs, from now on. */
  const logged = (name: string, match: (fields: unknown) => boolean = () => true) =>
    new Promise<void>((resolve) => waiters.push({ name, match, heard: resolve }));
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  // The root's Home exits on SIGTERM well inside the forced-stop grace, as in production.
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
    /**
     * One pass that ends at the line it is expected to log. `settle` waits for every background
     * task, and an open stream's lease release is one, so a test that holds a stream open uses this.
     */
    until: async (at: number, line: Promise<void>) => {
      now = at;
      await f.upkeep();
      await line;
    },
    logged,
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

test("a root whose readiness answers ready for its boot only after 1.6 s is not stopped", async (context) => {
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
});

test("a root that answers ready late for 110 s is never stopped, is read once in that time, and serves again on its boot", async (context) => {
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
});

test("a root that answers ready late forever is stopped at the first pass from aliveRefusingMs, then restarts", async (context) => {
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
});

test("a root that answers ready in time while its warm read refuses is never stopped and read once a bound, past aliveRefusingMs too", async (context) => {
  const r = await root(context);
  // Readiness is on time; keeping the container awake fails, so every warm read refuses.
  r.f.old.hooks.keepAlive = async () => {
    throw new Error("synthetic: inactivity timeout refused");
  };
  const start = r.now();
  // Passes 10 s apart from the limit on, so a read every pass would show past it.
  const passes = [0, unservingBoundMs];
  for (let at = aliveRefusingMs; at <= 2 * aliveRefusingMs; at += 10_000) passes.push(at);
  for (const at of passes) await r.pass(start + at);
  assert.deepEqual(r.f.old.calls.signals, []);
  assert.deepEqual(
    r.spared().map((spare) => spare.refusingMs),
    [1, 2, 3, 4].map((bounds) => bounds * unservingBoundMs),
  );
});

test("a stream in flight on a late root is spared at 60 s, holds the stop from 120 s, and is stopped with the stream still open once its count stood still for leakedStreamsMs", async (context) => {
  const r = await root(context);
  // One model call whose answer keeps streaming, as a long turn does.
  const encoder = new TextEncoder();
  let push!: (text: string) => void;
  r.f.onModel(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(encoder.encode(text));
            push("data: first\n\n");
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const response = await r.f.model();
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  try {
    assert.equal((await reader.read()).done, false);
    const start = r.now();
    answerLate(r.f, r.boot);
    // Every pass of a late root that isn't stopped ends with the recovery still pending.
    const pending = () => r.logged("POOL_SELECTED_RECOVERY_PENDING");
    let at = 0;
    for (; at < aliveRefusingMs; at += 10_000) await r.until(start + at, pending());
    assert.deepEqual(
      r.spared().map((spare) => spare.refusingMs),
      [unservingBoundMs],
    );
    assert.ok(!r.phases().includes("waiting_for_streams"), "spared, not yet held by the stream");
    for (; at < leakedStreamsMs; at += 10_000) {
      await r.until(start + at, pending());
      push("data: more\n\n");
      assert.equal((await reader.read()).done, false, "the stream still produces output");
    }
    assert.deepEqual(r.f.old.calls.signals, [], "not stopped while the count may still be live");
    assert.ok(r.phases().includes("waiting_for_streams"));
    const stopped = r.logged(
      "POOL_SELECTED_RECOVERY",
      (fields) => (fields as { phase?: string } | undefined)?.phase === "stopped",
    );
    await r.until(start + at, stopped);
    assert.equal(at, leakedStreamsMs);
    assert.deepEqual(r.f.old.calls.signals, [15], "stopped with the stream still open");
  } finally {
    await reader.cancel();
  }
});

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

test("a root whose readiness answers 503 is stopped at the bound", (context) =>
  stoppedAtTheBound(
    context,
    (f, boot) => async () =>
      f.old.identity().bootId === boot ? new Response(null, { status: 503 }) : undefined,
  ));

test("a root whose readiness never answers is stopped at the bound, after its liveness read gives up", (context) =>
  stoppedAtTheBound(
    context,
    (f, boot) => () =>
      f.old.identity().bootId === boot ? new Promise<never>(() => {}) : Promise.resolve(),
  ));

test("a root whose readiness answers ready for another boot is stopped at the bound", (context) =>
  stoppedAtTheBound(
    context,
    (f, boot) => async () =>
      f.old.identity().bootId === boot
        ? Response.json(
            { boot_id: "another-boot", started_at: "fixture-started" },
            { headers: { [policyHealthHeader]: "1500" } },
          )
        : undefined,
  ));
