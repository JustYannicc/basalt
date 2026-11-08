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
