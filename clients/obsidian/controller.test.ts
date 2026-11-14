import { test } from "node:test";
import assert from "node:assert/strict";
import { createController } from "./controller.ts";
import type { Http } from "./http.ts";
import type { SyncState } from "./types.ts";
test("cancelling a reconnect restores the old connection's prior pause state", async () => {
  const resource = "https://cloud.fixture.invalid/mcp?connection=device&elicitation_mode=native",
    issuer = "https://identity.fixture.invalid/auth",
    config = { connection: resource, appId: "app", appSlug: "obsidian" },
    values = new Map<string, string>();
  let state: SyncState | null = null;
  const reply = (value: unknown) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  const http: Http = async (url) => {
    if (url.includes("oauth-protected-resource"))
      return reply({ resource, authorization_servers: [issuer] });
    if (url.includes("oauth-authorization-server"))
      return reply({
        issuer,
        registration_endpoint: issuer + "/register",
        device_authorization_endpoint: issuer + "/device",
        token_endpoint: issuer + "/token",
      });
    if (url.endsWith("/register")) return reply({ client_id: "fixture-client" });
    if (url.endsWith("/device"))
      return reply({
        device_code: "fixture-code",
        user_code: "BCDF-GHJK",
        verification_uri: issuer + "/approve",
        expires_in: 600,
        interval: 5,
      });
    throw new Error("Unexpected fixture request");
  };
  values.set(
    "device",
    JSON.stringify({
      config,
      session: {
        resource,
        clientId: "fixture-client",
        tokenEndpoint: issuer + "/token",
        revocationEndpoint: null,
        accessToken: "fixture-access",
        refreshToken: "",
        expiresAt: Date.now() + 3600000,
      },
      paused: false,
    }),
  );
  const controller = await createController({
    http,
    local: { files: async () => [], read: async () => null, replace: async () => true },
    states: () => ({
      load: async () => state,
      save: async (value) => {
        state = value;
      },
    }),
    secrets: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => {
        values.set(key, value);
      },
    },
    key: "device",
    changed: () => {},
  });
  try {
    await controller.begin(config);
    assert.equal(controller.status().state, "authorizing");
    controller.cancel();
    assert.equal(controller.status().state, "idle");
  } finally {
    await controller.close();
  }
});

/**
 * A device already connected (as by Signalbox Sync 0.2.3) reconnects. `next` names where the new
 * link points; the server revokes tokens unless told the revocation endpoint is down.
 */
async function reconnect(
  next: { appId: string; origin?: string },
  revocationDown = false,
  times = 1,
  downStatus = 503,
) {
  const issuer = "https://identity.fixture.invalid/auth",
    resource = (origin: string) => `${origin}/mcp?connection=device&elicitation_mode=native`,
    before = resource("https://cloud.fixture.invalid"),
    after = resource(next.origin ?? "https://cloud.fixture.invalid"),
    values = new Map<string, string>(),
    revoked: string[] = [];
  const reply = (value: unknown, status = 200) => ({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  let down = revocationDown,
    issued = 0;
  const http: Http = async (url, init) => {
    if (url.includes("oauth-protected-resource"))
      return reply({ resource: after, authorization_servers: [issuer] });
    if (url.includes("oauth-authorization-server"))
      return reply({
        issuer,
        registration_endpoint: issuer + "/register",
        device_authorization_endpoint: issuer + "/device",
        token_endpoint: issuer + "/token",
        revocation_endpoint: issuer + "/revoke",
      });
    if (url.endsWith("/register")) return reply({ client_id: "new-client" });
    if (url.endsWith("/device"))
      return reply({
        device_code: "fixture-code",
        user_code: "BCDF-GHJK",
        verification_uri: issuer + "/approve",
        expires_in: 600,
        interval: 5,
      });
    if (url.endsWith("/token")) {
      issued++;
      return reply({
        access_token: `new-access-${issued}`,
        refresh_token: `new-refresh-${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.endsWith("/revoke")) {
      if (down) return reply({}, downStatus);
      revoked.push(new URLSearchParams(init.body).get("token") ?? "");
      return reply({});
    }
    throw new Error("Unexpected fixture request");
  };
  values.set(
    "device",
    JSON.stringify({
      config: { connection: before, appId: "app", appSlug: "obsidian" },
      session: {
        resource: before,
        clientId: "old-client",
        tokenEndpoint: issuer + "/token",
        revocationEndpoint: issuer + "/revoke",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 3600000,
      },
      paused: false,
    }),
  );
  let state: SyncState | null = null;
  const start = () =>
    createController({
      http,
      local: { files: async () => [], read: async () => null, replace: async () => true },
      states: () => ({
        load: async () => state,
        save: async (value) => {
          state = value;
        },
      }),
      secrets: {
        get: (key) => values.get(key) ?? null,
        set: (key, value) => {
          values.set(key, value);
        },
      },
      key: "device",
      changed: () => {},
    });
  // Revocation runs in the background; wait until nothing is left to revoke or it gave up.
  const settle = async (expected: number) => {
    for (let turn = 0; turn < 100 && revoked.length < expected; turn++)
      await new Promise((resolve) => setImmediate(resolve));
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const controller = await start();
  try {
    for (let round = 0; round < times; round++) {
      await controller.begin({ connection: after, appId: next.appId, appSlug: "obsidian" });
      assert.equal(await controller.poll(), true);
    }
    await settle(down ? 0 : 2 * times);
  } finally {
    await controller.close();
  }
  // The device keeps the newest access whatever happened to the old ones.
  assert.equal(
    JSON.parse(values.get("device") ?? "{}").session?.accessToken,
    `new-access-${times}`,
  );
  return {
    revoked,
    /** Replaced access still saved for revoking. */
    pending: () => values.get("device-replaced") ?? "",
    /** Restart the plugin with the revocation endpoint back, as after an outage. */
    restart: async () => {
      down = false;
      const again = await start();
      await settle(2 * times);
      await again.close();
      return revoked;
    },
  };
}

test("reconnecting the same vault app revokes the device's earlier access, so it isn't listed twice", async () => {
  const { revoked, pending } = await reconnect({ appId: "app" });
  assert.deepEqual(revoked, ["old-refresh", "old-access"]);
  assert.equal(pending(), "");
});

test("connecting to another vault app or server leaves the earlier access alone", async () => {
  assert.deepEqual((await reconnect({ appId: "other-app" })).revoked, []);
  assert.deepEqual(
    (await reconnect({ appId: "app", origin: "https://other.fixture.invalid" })).revoked,
    [],
  );
});

test("an earlier access that can't be revoked yet is revoked when the plugin next starts", async () => {
  const { revoked, pending, restart } = await reconnect({ appId: "app" }, true);
  assert.deepEqual(revoked, []);
  assert.notEqual(pending(), "");
  assert.deepEqual(await restart(), ["old-refresh", "old-access"]);
  assert.equal(pending(), "");
});

test("reconnecting twice while revocation is down keeps both earlier accesses until revoked", async () => {
  const { pending, restart } = await reconnect({ appId: "app" }, true, 2);
  assert.equal(JSON.parse(pending()).length, 2);
  assert.deepEqual(await restart(), ["old-refresh", "old-access", "new-refresh-1", "new-access-1"]);
  assert.equal(pending(), "");
});

test("an earlier access the server refuses outright isn't retried on every start", async () => {
  const { revoked, pending } = await reconnect({ appId: "app" }, true, 1, 401);
  assert.deepEqual(revoked, []);
  assert.equal(pending(), "");
});
