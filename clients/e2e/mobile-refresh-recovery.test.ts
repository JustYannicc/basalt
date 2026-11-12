import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, fixture } from "./mobile-reconnect-fixture.ts";

test("an offline refresh proven not sent keeps its token and recovers after an expiry outage", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.expire();
  f.offline();
  f.failRefresh(new Error("fetch failed: java.io.IOException: SIGNALBOX_REFRESH_NOT_SENT"));
  const attempt = f.controller.foreground(true);
  await advance(t, 120_000);
  await attempt;
  assert.equal(f.controller.getSnapshot().connection?.state, "connected");
  assert.equal(f.controller.getSnapshot().reconnecting, true);
  assert.equal(f.saved().refreshPending, "not-sent");
  assert.equal(f.saved().refreshToken, "fixture-refresh");
  assert.ok(f.refreshReads() > 1);
  const before = f.refreshReads();
  f.failRefresh(undefined);
  f.online();
  await advance(t, 20_000);
  assert.ok(f.refreshReads() > before);
  assert.equal(f.saved().refreshPending, false);
  assert.equal(f.saved().refreshToken, "fixture-next-refresh");
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  await f.controller.close();
});

for (const message of [
  "fetch failed: java.net.UnknownHostException: unavailable",
  "fetch failed: java.net.ConnectException: refused",
  "fetch failed: java.net.SocketTimeoutException: timeout",
  "fetch failed: java.net.SocketException: Connection reset",
  "Network request failed",
  "prefix fetch failed: java.io.IOException: SIGNALBOX_REFRESH_NOT_SENT",
]) {
  test(`a refresh without whole-call not-sent proof stays uncertain: ${message}`, async (t) => {
    const f = fixture(t);
    await f.controller.initialize();
    f.expire();
    f.failRefresh(new Error(message));
    const attempt = f.controller.foreground(true);
    await advance(t, 1000);
    await attempt;
    assert.equal(f.controller.getSnapshot().connection?.state, "sign-in-required");
    assert.equal(f.saved().refreshPending, true);
    assert.equal(f.refreshReads(), 1);
    f.notifyNetwork(true);
    await advance(t, 20_000);
    assert.equal(f.refreshReads(), 1);
    await f.controller.close();
  });
}

for (const action of ["signOut", "signIn"] as const) {
  test(`a delayed not-sent refresh write cannot overwrite later ${action}`, async (t) => {
    const f = fixture(t);
    await f.controller.initialize();
    f.expire();
    f.failRefresh(new Error("fetch failed: java.io.IOException: SIGNALBOX_REFRESH_NOT_SENT"));
    let release!: () => void;
    f.holdNotSentWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const reconnect = f.controller.foreground(true);
    await advance(t, 100);
    let complete = false;
    const changed = (
      action === "signOut"
        ? f.controller.signOut()
        : f.controller.signIn("https://fixture.example.test")
    ).then(() => {
      complete = true;
    });
    await advance(t, 6000);
    assert.equal(complete, false);
    release();
    await advance(t, 100);
    await Promise.all([reconnect, changed]);
    if (action === "signOut") assert.equal(f.rawSaved(), undefined);
    else {
      assert.equal(f.saved().accessToken, "fixture-signed-in-access");
      assert.equal(f.controller.getSnapshot().connection?.state, "connected");
    }
    await f.controller.close();
  });
}
