import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, advance } from "./mobile-reconnect-fixture.ts";

test("online recovery replaces an attempt whose native promise never settles", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.ignoreAbort();
  f.hold(new Promise<void>(() => {}));
  const old = f.controller.foreground(true);
  await advance(t, 100);
  f.hold(undefined);
  f.notifyNetwork(true);
  await advance(t, 1000);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.equal(f.reads(), 3);
  assert.equal(f.signals[1]?.aborted, true);
  await old;
  await f.controller.close();
});

test("a hung reconnect expires and retries without an online event", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.ignoreAbort();
  f.hold(new Promise<void>(() => {}));
  const old = f.controller.foreground(true);
  await advance(t, 100);
  f.hold(undefined);
  await advance(t, 15_000);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.equal(f.reads(), 3);
  assert.equal(f.signals[1]?.aborted, true);
  await old;
  await f.controller.close();
});

test("manual Reconnect cancels a hung attempt and starts fresh", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.ignoreAbort();
  f.hold(new Promise<void>(() => {}));
  const old = f.controller.foreground(true);
  await advance(t, 100);
  f.hold(undefined);
  const manual = f.controller.reconnect();
  await advance(t, 1000);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.equal(f.reads(), 3);
  assert.equal(f.signals[1]?.aborted, true);
  await Promise.all([old, manual]);
  await f.controller.close();
});

test("a late cancelled 401 cannot replace the recovered connection", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.ignoreAbort();
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const old = f.controller.foreground(true);
  await advance(t, 100);
  f.hold(undefined);
  f.notifyNetwork(true);
  await advance(t, 100);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  f.status(401);
  release();
  await advance(t, 100);
  await old;
  assert.equal(f.controller.getSnapshot().connection?.state, "connected");
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().error, undefined);
  await f.controller.close();
});

test("three consecutive twenty-second and two-minute outages recover on the same phone", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.ignoreAbort();
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const duration of [20_000, 120_000]) {
      await f.controller.foreground(false);
      f.offline();
      f.hold(new Promise<void>(() => {}));
      const resumed = f.controller.foreground(true);
      await advance(t, duration);
      f.hold(undefined);
      f.online();
      const before = f.reads();
      f.notifyNetwork(true);
      await advance(t, 1000);
      await resumed;
      assert.equal(f.reads(), before + 1);
      assert.equal(f.controller.getSnapshot().reconnecting, false);
      assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
      assert.ok(f.signals.slice(1, -1).every((signal) => signal.aborted));
    }
  }
  await f.controller.close();
});

test("a timed-out rotating refresh stays sign-in-required and is never replayed", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.expire();
  let release!: () => void;
  f.holdRefresh(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const attempt = f.controller.foreground(true);
  await advance(t, 15_000);
  await attempt;
  assert.equal(f.controller.getSnapshot().connection?.state, "sign-in-required");
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.equal(f.refreshReads(), 1);
  f.notifyNetwork(true);
  await advance(t, 60_000);
  release();
  await advance(t, 100);
  assert.equal(f.refreshReads(), 1);
  assert.equal(f.saved().refreshPending, true);
  assert.equal(f.saved().accessToken, "fixture-access");
  assert.equal(f.controller.getSnapshot().connection?.state, "sign-in-required");
  await f.controller.close();
});
