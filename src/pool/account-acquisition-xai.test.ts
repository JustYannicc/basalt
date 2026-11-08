import assert from "node:assert/strict";
import test from "node:test";
import { fixture, body } from "./test/account-acquisition.ts";

test("xAI accepts the displayed code and a code URL using its retained state", async () => {
  for (const value of [
    "  displayed-code  ",
    "http://127.0.0.1:56121/callback?code=displayed-code&state=home-state",
    "https://accounts.x.ai/complete?code=displayed-code",
  ]) {
    const f = fixture([], "xai");
    const started = await body(await f.send("start"));
    assert.deepEqual(started.paste, { label: "Paste the code xAI shows you" });
    assert.equal(
      (await body(await f.send("submit", { session: started.session, value }))).state,
      "waiting",
    );
    assert.deepEqual(f.calls.find((call) => call.path.endsWith("/oauth/callback"))?.body, {
      provider: "xai",
      state: "home-state",
      code: "displayed-code",
    });
    f.complete(["xai-account"]);
    assert.equal(
      (await body(await f.send("status", { session: started.session }))).state,
      "connected",
    );
  }
});

test("a wrong xAI paste never reaches Home and the same attempt accepts a corrected code", async () => {
  const f = fixture([], "xai");
  const started = await body(await f.send("start"));
  for (const value of [
    "https://accounts.x.ai/oauth2/consent?response_type=code&state=home-state",
    "http://127.0.0.1:56121/callback?code=c&state=another-session",
    "code#another-session",
  ]) {
    const response = await f.send("submit", { session: started.session, value });
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).receipt, {
      phase: "oauth_callback",
      errorClass: "invalid_code",
      retryable: true,
    });
  }
  assert.equal(f.calls.filter((call) => call.path.endsWith("/oauth/callback")).length, 0);
  assert.equal(
    (await body(await f.send("submit", { session: started.session, value: "correct-code" }))).state,
    "waiting",
  );
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
});

test("xAI device sign-in shows its code without asking for a callback and honors provider expiry", async () => {
  const f = fixture([], "xai", {
    flow: "device",
    url: "https://accounts.x.ai/oauth2/device",
    user_code: "USER-CODE",
    expires_in: 600,
  });
  const before = Date.now();
  const started = await body(await f.send("start"));
  const after = Date.now();
  assert.equal(started.paste, undefined);
  assert.equal(started.code, "USER-CODE");
  assert.ok(
    Number(started.expiresAt) >= before + 600_000 && Number(started.expiresAt) <= after + 600_000,
  );
  f.complete(["xai-device-account"]);
  assert.equal(
    (await body(await f.send("status", { session: started.session }))).state,
    "connected",
  );
  assert.equal(
    f.calls.some((call) => call.path.endsWith("/oauth/callback")),
    false,
  );
});

test("xAI distinguishes an expired Home session from a code that can be corrected", async () => {
  const f = fixture([], "xai");
  const started = await body(await f.send("start"));
  f.failCallback(400);
  const invalid = await f.send("submit", { session: started.session, value: "rejected-code" });
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).receipt.errorClass, "invalid_code");
  f.failCallback();
  assert.equal(
    (await body(await f.send("submit", { session: started.session, value: "correct-code" }))).state,
    "waiting",
  );
  f.failCallback(404);
  assert.deepEqual(
    await body(await f.send("submit", { session: started.session, value: "new-code" })),
    {
      state: "failed",
      message: "xAI sign-in expired. Start again to get a new code.",
    },
  );
  assert.equal(f.markers.size, 0);
});
