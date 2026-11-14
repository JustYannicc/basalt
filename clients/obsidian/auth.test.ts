import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginConnection,
  pollConnection,
  refreshSession,
  revokeSession,
  connectionUrl,
} from "./auth.ts";
import type { Http } from "./http.ts";
const source = "https://vault.fixture.invalid/mcp?connection=device-one",
  resource = source + "&elicitation_mode=native",
  issuer = "https://identity.fixture.invalid/auth";
const response = (body: unknown, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
function server() {
  let challenge = "",
    pending = true,
    slowed = false,
    revoked = false;
  const calls: { url: string; body: string | undefined }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.includes("oauth-protected-resource"))
      return response({ resource, authorization_servers: [issuer] });
    if (url.includes("oauth-authorization-server"))
      return response({
        issuer,
        registration_endpoint: issuer + "/register",
        device_authorization_endpoint: issuer + "/device",
        token_endpoint: issuer + "/token",
        revocation_endpoint: issuer + "/revoke",
      });
    if (url.endsWith("/register")) return response({ client_id: "public-device" }, 201);
    const form = new URLSearchParams(init.body);
    if (url.endsWith("/device")) {
      assert.equal(form.get("resource"), resource);
      assert.equal(form.get("code_challenge_method"), "S256");
      challenge = form.get("code_challenge")!;
      return response({
        device_code: "private-device-code",
        user_code: "BCDF-GHJK",
        verification_uri: issuer + "/approve",
        verification_uri_complete: issuer + "/approve?user_code=BCDF-GHJK",
        expires_in: 600,
        interval: 5,
      });
    }
    if (url.endsWith("/revoke")) {
      revoked = true;
      return response({});
    }
    if (url.endsWith("/token")) {
      if (revoked) return response({ error: "invalid_grant" }, 400);
      if (form.get("grant_type") === "refresh_token") {
        assert.equal(form.get("resource"), resource);
        return response({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      const verifier = form.get("code_verifier");
      assert.ok(verifier);
      assert.equal(
        b64(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
        ),
        challenge,
      );
      if (slowed) {
        slowed = false;
        return response({ error: "slow_down" }, 400);
      }
      if (pending) return response({ error: "authorization_pending" }, 400);
      return response({
        access_token: "device-access",
        refresh_token: "device-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error("Unexpected authorization endpoint");
  };
  return {
    http,
    calls,
    approve: () => {
      pending = false;
    },
    slow: () => {
      slowed = true;
    },
  };
}
test("device authorization binds proof and tokens to an app-scoped native connection; refresh rotates both tokens", async () => {
  const s = server(),
    pending = await beginConnection(s.http, source, 1000);
  assert.equal(pending.resource, resource);
  assert.equal(pending.userCode, "BCDF-GHJK");
  assert.deepEqual(await pollConnection(s.http, pending, 2000), { state: "pending", interval: 5 });
  s.slow();
  assert.deepEqual(await pollConnection(s.http, pending, 3000), { state: "pending", interval: 10 });
  s.approve();
  const result = await pollConnection(s.http, pending, 4000);
  assert.equal(result.state, "connected");
  if (result.state !== "connected") throw new Error("Expected authorization");
  const renewed = await refreshSession(s.http, result.session, 5000);
  assert.equal(renewed.accessToken, "rotated-access");
  assert.equal(renewed.refreshToken, "rotated-refresh");
  assert.equal(renewed.resource, resource);
  await revokeSession(s.http, renewed);
  assert.deepEqual(
    s.calls
      .filter((x) => x.url.endsWith("/revoke"))
      .map((x) => new URLSearchParams(x.body).get("token")),
    ["rotated-refresh", "rotated-access"],
  );
  await assert.rejects(refreshSession(s.http, renewed, 6000), /removed or expired/);
});
test("a broad or unsafe login is refused before sending credentials; expired pairing never polls", async () => {
  let calls = 0;
  const http: Http = async () => {
    calls++;
    throw new Error("Must not call");
  };
  await assert.rejects(beginConnection(http, "https://vault.fixture.invalid/mcp"), /app-scoped/);
  await assert.rejects(
    beginConnection(http, "http://vault.fixture.invalid/mcp?connection=one"),
    /HTTPS/,
  );
  assert.equal(calls, 0);
  assert.equal(connectionUrl(source), resource);
  const s = server(),
    pending = await beginConnection(s.http, source, 1000),
    before = s.calls.length;
  await assert.rejects(pollConnection(s.http, pending, pending.expiresAt), /expired/);
  assert.equal(s.calls.length, before);
});

test("a device names itself and its vault when it connects; without a report it asks as before", async () => {
  const sent = async (report?: { device?: string; vault?: string }) => {
    const s = server();
    await beginConnection(s.http, source, 1000, false, report);
    const body = (path: string) => s.calls.find((call) => call.url.endsWith(path))?.body ?? "";
    return {
      registered: JSON.parse(body("/register")).client_name,
      device: Object.fromEntries(new URLSearchParams(body("/device"))),
    };
  };
  const named = await sent({ device: "Alex MacBook Pro", vault: "Personal" });
  assert.equal(named.registered, "Alex MacBook Pro");
  assert.equal(named.device.device_name, "Alex MacBook Pro");
  assert.equal(named.device.device_context, "Personal");
  const plain = await sent();
  assert.equal(plain.registered, "Signalbox Obsidian Sync");
  assert.equal("device_name" in plain.device, false);
  assert.equal("device_context" in plain.device, false);
});
