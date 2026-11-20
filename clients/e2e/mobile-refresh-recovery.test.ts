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

test("an online event waits for an in-flight refresh instead of cancelling its token response", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.expire();
  let release!: () => void;
  f.holdRefresh(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const resumed = f.controller.foreground(true);
  await advance(t, 100);
  assert.equal(f.refreshReads(), 1);
  f.notifyNetwork(true);
  await advance(t, 100);
  release();
  await advance(t, 1000);
  await resumed;
  assert.equal(f.refreshReads(), 1);
  assert.equal(f.controller.getSnapshot().connection?.state, "connected");
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.equal(f.saved().accessToken, "fixture-next-access");
  assert.equal(f.saved().refreshPending, false);
  await f.controller.close();
});

test("a lost refresh response replays the old token and saves the server's same new pair", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.expire();
  f.failRefresh(new Error("Synthetic response lost after rotation"));
  const attempt = f.controller.foreground(true);
  await advance(t, 100);
  await attempt;
  assert.equal(f.controller.getSnapshot().connection?.state, "connected");
  assert.equal(f.saved().refreshToken, "fixture-refresh");
  f.failRefresh(undefined);
  await advance(t, 20_000);
  assert.deepEqual(f.refreshTokens, ["fixture-refresh", "fixture-refresh"]);
  assert.equal(f.saved().accessToken, "fixture-next-access");
  assert.equal(f.saved().refreshToken, "fixture-next-refresh");
  assert.equal(f.saved().refreshPending, false);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  await f.controller.close();
});

test("a definitive refresh refusal requires sign-in and is not replayed", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.expire();
  f.refuseRefresh(400, "invalid_grant");
  const attempt = f.controller.foreground(true);
  await advance(t, 100);
  await attempt;
  assert.equal(f.controller.getSnapshot().connection?.state, "sign-in-required");
  f.notifyNetwork(true);
  await advance(t, 60_000);
  assert.equal(f.refreshReads(), 1);
  await f.controller.close();
});

test("unknown refresh outcomes keep replaying past the server's window; only a refusal asks for sign-in", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.expire();
  f.failRefresh(new Error("Synthetic response lost after rotation"));
  const attempt = f.controller.foreground(true);
  await advance(t, 610_000);
  await attempt;
  const early = f.refreshReads();
  await advance(t, 60_000);
  assert.ok(f.refreshReads() > early, "Ten minutes without an answer does not end replay.");
  await advance(t, 2_940_000);
  const reads = f.refreshReads();
  await advance(t, 60_000);
  // Without an answer the server has refused nothing, and a sign-in would not reach it either.
  assert.ok(f.refreshReads() > reads, "An hour without an answer does not end replay.");
  assert.notEqual(f.controller.getSnapshot().connection?.state, "sign-in-required");
  assert.equal(f.saved().refreshToken, "fixture-refresh");
  assert.equal(f.saved().refreshPending, true);
  f.failRefresh(undefined);
  f.refuseRefresh(400, "invalid_grant");
  const refused = f.refreshReads();
  await advance(t, 60_000);
  assert.equal(f.controller.getSnapshot().connection?.state, "sign-in-required");
  assert.equal(f.controller.getSnapshot().error, "Sign in again to reconnect this phone.");
  assert.equal(f.refreshReads(), refused + 1, "One send meets the refusal; none follow it.");
  await f.controller.close();
});

for (const message of [
  "fetch failed: java.net.UnknownHostException: unavailable",
  "fetch failed: java.net.SocketTimeoutException: timeout",
  "prefix fetch failed: java.io.IOException: SIGNALBOX_REFRESH_NOT_SENT",
]) {
  test(`an unproven refresh failure retains unknown intent for bounded replay: ${message}`, async (t) => {
    const f = fixture(t);
    await f.controller.initialize();
    f.expire();
    f.failRefresh(new Error(message));
    const attempt = f.controller.foreground(true);
    await advance(t, 100);
    await attempt;
    assert.equal(f.saved().refreshPending, true);
    assert.equal(f.controller.getSnapshot().connection?.state, "connected");
    await f.controller.close();
  });
}

test("a retryable refresh server error recovers without requiring sign-in", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.expire();
  f.refuseRefresh(503, "server_error");
  const attempt = f.controller.foreground(true);
  await advance(t, 100);
  await attempt;
  assert.equal(f.controller.getSnapshot().connection?.state, "connected");
  f.allowRefresh();
  await advance(t, 20_000);
  assert.equal(f.refreshReads(), 2);
  assert.equal(f.saved().refreshPending, false);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  await f.controller.close();
});

for (const [status, code] of [
  [400, "invalid_request"],
  [415, "unsupported_media_type"],
] as const) {
  test(`a non-authentication refresh rejection retains credentials: ${status} ${code}`, async (t) => {
    const f = fixture(t);
    await f.controller.initialize();
    f.expire();
    f.refuseRefresh(status, code);
    const attempt = f.controller.foreground(true);
    await advance(t, 100);
    await attempt;
    assert.equal(f.controller.getSnapshot().connection?.state, "connected");
    assert.equal(f.saved().refreshToken, "fixture-refresh");
    assert.equal(f.saved().refreshPending, true);
    f.allowRefresh();
    await advance(t, 20_000);
    assert.equal(f.refreshReads(), 2);
    assert.equal(f.saved().refreshPending, false);
    assert.equal(f.controller.getSnapshot().reconnecting, false);
    await f.controller.close();
  });
}
