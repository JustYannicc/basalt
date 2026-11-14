// RFC 7009 §2.2: revoking a token the server no longer honours succeeds. A device disconnects by
// revoking its refresh token and then its access token, and the first already invalidates the
// second, so anything but 200 there leaves the device unable to disconnect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { revokeSession } from "../../clients/obsidian/auth.ts";
import type { Http } from "../../clients/obsidian/http.ts";
import { fixture } from "./native-device-fixture.ts";

const origin = "http://localhost:3000";
const revocationEndpoint = `${origin}/api/auth/oauth2/revoke`;

async function issued() {
  const f = await fixture(async (request) => {
    const { envelope } = await request.json();
    const { action } = JSON.parse(Buffer.from(envelope.split(".")[1], "base64url").toString());
    return Response.json(
      action === "register"
        ? { computer: { id: "computer-fixture" }, pool: "pool-fixture", models: true }
        : action === "check"
          ? { active: true }
          : { revoked: true },
    );
  });
  try {
    const approved = await f.request(
      "/device/decide",
      { user_code: f.user_code, accept: true },
      {
        "x-basalt-native-intent": "synthetic-intent",
        "x-basalt-native-name": "Test device",
        "x-basalt-native-pool": "pool-fixture",
        "x-basalt-native-models": "true",
        "x-basalt-native-tools": "false",
      },
    );
    assert.equal(approved.status, 200);
    const token = await f.raw("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: f.device_code,
        client_id: f.client_id,
        code_verifier: f.verifier,
        resource: `${origin}/native`,
      }),
    });
    assert.equal(token.status, 200);
    const { access_token, refresh_token } = await token.json();
    assert.equal(typeof refresh_token, "string", "the fixture must issue a refresh token");
    return { ...f, access_token: access_token as string, refresh_token: refresh_token as string };
  } catch (error) {
    f[Symbol.dispose]();
    throw error;
  }
}

const revoke = (
  f: Awaited<ReturnType<typeof issued>>,
  body: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  f.raw("/oauth2/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body),
  });

test("a device's disconnect succeeds, and succeeds again when retried", async () => {
  using f = await issued();
  // The plugin's own revocation, against the real server.
  const http: Http = async (url, init) => {
    assert.equal(url, revocationEndpoint);
    const reply = await f.raw(new URL(url).pathname.replace("/api/auth", ""), init);
    return { status: reply.status, headers: {}, body: await reply.text() };
  };
  const session = {
    resource: `${origin}/native`,
    clientId: f.client_id,
    tokenEndpoint: `${origin}/api/auth/oauth2/token`,
    revocationEndpoint,
    accessToken: f.access_token,
    refreshToken: f.refresh_token,
    expiresAt: Date.now() + 60_000,
  };
  await revokeSession(http, session);
  await revokeSession(http, session);
});

test("revoking an access token its refresh token already invalidated answers 200", async () => {
  using f = await issued();
  const client_id = f.client_id;
  const refresh = { token: f.refresh_token, token_type_hint: "refresh_token", client_id };
  const access = { token: f.access_token, token_type_hint: "access_token", client_id };
  assert.equal((await revoke(f, refresh)).status, 200);
  assert.equal((await revoke(f, access)).status, 200);
  assert.equal((await revoke(f, refresh)).status, 200);
  assert.equal((await revoke(f, { token: "never-issued", client_id })).status, 200);
  // The refresh token is gone, not just answered politely.
  const refreshed = await f.raw("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: f.refresh_token,
      client_id,
    }),
  });
  assert.notEqual(refreshed.status, 200);
});

test("a malformed revocation or an unknown client is still refused", async () => {
  using f = await issued();
  const missing = await revoke(f, { client_id: f.client_id });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "invalid_request");
  const stranger = await revoke(f, { token: f.access_token, client_id: "unknown-client" });
  assert.equal(stranger.status, 400);
  assert.equal((await stranger.json()).error, "invalid_client");
  // A refused revocation revoked nothing.
  assert.equal(
    (await f.raw("/native/access", { headers: { authorization: `Bearer ${f.access_token}` } }))
      .status,
    200,
  );
});
