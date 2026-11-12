import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, advance } from "./mobile-reconnect-fixture.ts";

test("a phone foregrounded offline recovers after a twenty-second outage without user action", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  await f.controller.foreground(false);
  f.offline();
  const resumed = f.controller.foreground(true);
  await advance(t, 20_000);
  await resumed;
  assert.equal(f.controller.getSnapshot().connection?.capabilities.length, 0);
  f.online();
  await advance(t, 30_000);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().error, undefined);
  const transport = await f.controller.run(
    (source, signal) => source.transport(signal),
    new AbortController().signal,
  );
  assert.equal(transport.mode, "device");
  await f.controller.foreground(false);
});

test("online network and health transitions reconnect immediately during backoff", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  await f.controller.foreground(false);
  f.offline();
  const resumed = f.controller.foreground(true);
  await advance(t, 20_000);
  await resumed;
  f.online();
  const before = f.reads();
  f.notifyNetwork(true);
  await advance(t, 50);
  assert.equal(f.reads(), before + 1);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);

  f.offline();
  const health = f.controller.checkHealth();
  await advance(t, 2000);
  await health;
  assert.equal(f.controller.getSnapshot().reconnecting, true);
  // Health's ten-second cache expires while automatic recovery is backing off.
  await advance(t, 10_000);
  f.online();
  const checked = f.controller.checkHealth();
  await advance(t, 50);
  await checked;
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.equal(f.controller.getSnapshot().error, undefined);
  await f.controller.close();
});

test("a deploy-window 503 respects Retry-After and restores usable access", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.status(503, "20");
  const resumed = f.controller.foreground(true);
  await advance(t, 19_000);
  assert.equal(f.reads(), 2);
  f.status(200);
  await advance(t, 1050);
  await resumed;
  assert.ok(f.times[2]! - f.times[1]! >= 20_000);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().error, undefined);
  await f.controller.close();
});

test("a definitive 401 requires sign-in and never loops on timers or online events", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.status(401);
  await f.controller.foreground(true);
  assert.equal(f.controller.getSnapshot().connection?.state, "sign-in-required");
  assert.match(f.controller.getSnapshot().error!, /Sign in again/u);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  const reads = f.reads();
  f.notifyNetwork(true);
  await f.controller.checkHealth();
  await f.controller.foreground(true);
  await advance(t, 120_000);
  assert.equal(f.reads(), reads);
  await f.controller.close();
});

test("resume, network, health and manual recovery share one in-flight attempt", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const attempts = [
    f.controller.foreground(true),
    f.controller.foreground(true),
    f.controller.reconnect(),
    f.controller.checkHealth(),
  ];
  f.notifyNetwork(true);
  f.notifyNetwork(false);
  await advance(t, 1000);
  release();
  await advance(t, 100);
  await Promise.all(attempts);
  assert.equal(f.maximum(), 1);
  await f.controller.close();
});

test("disconnect and backgrounding cancel retries without replaying work", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.offline();
  const resumed = f.controller.foreground(true);
  await advance(t, 2000);
  await resumed;
  await f.controller.disconnect();
  const reads = f.reads();
  await f.controller.foreground(false);
  await f.controller.foreground(true);
  f.online();
  f.notifyNetwork(true);
  await advance(t, 60_000);
  assert.equal(f.reads(), reads);
  assert.equal(f.controller.getSnapshot().connection?.state, "disconnected");
  await f.controller.reconnect();
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  await f.controller.close();
});

test("a rapid background and foreground transition does not lose recovery", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.hold(new Promise<void>(() => {}));
  const reconnecting = f.controller.foreground(true);
  await advance(t, 50);
  const background = f.controller.foreground(false);
  f.hold(undefined);
  const foreground = f.controller.foreground(true);
  await advance(t, 50);
  await Promise.all([reconnecting, background, foreground]);
  assert.equal(f.maximum(), 1);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  await f.controller.close();
});

test("an automatic health recovery preserves active work and reconnects when it finishes", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  let release!: () => void;
  let activeSignal: AbortSignal | undefined;
  const running = f.controller
    .run(
      (_source, signal) =>
        new Promise<string>((resolve, reject) => {
          activeSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          release = () => resolve("completed");
        }),
      new AbortController().signal,
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  f.offline();
  const checking = f.controller.checkHealth();
  await advance(t, 2000);
  await checking;
  assert.equal(activeSignal?.aborted, false, "A health probe must not cancel application work.");
  f.online();
  release();
  assert.deepEqual(await running, { value: "completed" });
  await advance(t, 50);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  await f.controller.close();
});
