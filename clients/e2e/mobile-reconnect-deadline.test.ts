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
      f.notifyNetwork(false);
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

test("a timed-out rotating refresh stays signed in and recovers through replay", async (t) => {
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
  await advance(t, 35_000);
  await attempt;
  assert.equal(f.controller.getSnapshot().connection?.state, "connected");
  assert.equal(f.saved().refreshPending, true);
  release();
  await advance(t, 20_000);
  assert.ok(f.refreshReads() >= 2);
  assert.equal(f.saved().accessToken, "fixture-next-access");
  assert.equal(f.saved().refreshPending, false);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  await f.controller.close();
});

for (const action of ["signOut", "signIn"] as const) {
  test(`a cancelled rotation write cannot overwrite a later ${action}`, async (t) => {
    const f = fixture(t);
    await f.controller.initialize();
    f.expire();
    let release!: () => void;
    f.holdRotationWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const reconnect = f.controller.foreground(true);
    await advance(t, 100);
    let confirmed = false;
    const next = (
      action === "signOut"
        ? f.controller.signOut()
        : f.controller.signIn("https://fixture.example.test")
    ).then(() => {
      confirmed = true;
    });
    await advance(t, 6000);
    assert.equal(confirmed, false, "A newer credential mutation waits for the in-flight write.");
    release();
    await advance(t, 100);
    await Promise.all([reconnect, next]);
    if (action === "signOut") {
      assert.equal(f.rawSaved(), undefined);
      assert.equal(f.controller.getSnapshot().phase, "signed-out");
    } else {
      assert.equal(f.saved().accessToken, "fixture-signed-in-access");
      assert.equal(f.controller.getSnapshot().connection?.state, "connected");
    }
    await f.controller.close();
  });
}

test("cancelling one caller preserves a sibling's shared rotating refresh", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  let release!: () => void;
  f.holdRefresh(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  t.mock.timers.tick(3_550_000);
  const abort = new AbortController();
  const cancelled = f.controller.run((source, signal) => source.transport(signal), abort.signal);
  const rejected = assert.rejects(cancelled);
  const sibling = f.controller.run(
    (source, signal) => source.transport(signal),
    new AbortController().signal,
  );
  await advance(t, 100);
  assert.equal(f.refreshReads(), 1);
  abort.abort();
  await rejected;
  release();
  await advance(t, 100);
  assert.equal((await sibling).mode, "device");
  assert.equal(f.refreshReads(), 1);
  assert.equal(f.saved().refreshPending, false);
  assert.equal(f.saved().accessToken, "fixture-next-access");
  assert.equal(f.controller.getSnapshot().connection?.state, "connected");
  await f.controller.close();
});

test("repeated online notifications do not cancel the replacement attempt", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.ignoreAbort();
  f.hold(new Promise<void>(() => {}));
  const original = f.controller.foreground(true);
  await advance(t, 100);
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.notifyNetwork(false);
  f.notifyNetwork(true);
  await advance(t, 100);
  const replacement = f.signals.at(-1);
  for (let count = 0; count < 5; count++) {
    f.notifyNetwork(true);
    await advance(t, 100);
  }
  assert.equal(f.reads(), 3);
  assert.equal(replacement?.aborted, false);
  release();
  await advance(t, 100);
  await original;
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  await f.controller.close();
});

for (const action of ["online", "manual", "signOut"] as const) {
  test(`a stuck native storage read cannot block later ${action}`, async (t) => {
    const f = fixture(t);
    await f.controller.initialize();
    f.holdStoreRead(new Promise<void>(() => {}));
    const old = f.controller.foreground(true);
    await advance(t, 100);
    f.holdStoreRead(undefined);
    let completed = false;
    let next: Promise<void> | undefined;
    if (action === "online") f.notifyNetwork(true);
    else
      next = (action === "manual" ? f.controller.reconnect() : f.controller.signOut()).then(() => {
        completed = true;
      });
    await advance(t, 1000);
    if (action === "signOut") {
      assert.equal(completed, true);
      assert.equal(f.rawSaved(), undefined);
      assert.equal(f.controller.getSnapshot().phase, "signed-out");
    } else {
      assert.equal(f.storeReads(), 4);
      assert.equal(f.controller.getSnapshot().reconnecting, false);
      assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
    }
    await Promise.all([old, next]);
    await f.controller.close();
  });
}
