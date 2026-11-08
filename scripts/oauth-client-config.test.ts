import assert from "node:assert/strict";
import { test } from "node:test";
import { deployEnvironment, optionalConnectorClients, requiredSecrets } from "./environment.ts";

const credentials = () => ({
  ...Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"])),
  POOL_APP_SIGNING_KEY: "ab".repeat(32),
  POOL_DEPLOYMENT_KEY: "ef".repeat(32),
});

test("release refuses a client secret in every hosted connector client ID without exposing it", () => {
  for (const client of optionalConnectorClients) {
    for (const prefix of ["pscale_app_secret_", "GOCSPX-"]) {
      const misplaced = `${prefix}synthetic-private-marker`;
      assert.throws(
        () =>
          deployEnvironment({
            ...credentials(),
            [client.id]: misplaced,
            [client.secret]: "different-synthetic-secret",
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "OAuthClientConfigurationError");
          assert.equal(
            error.message,
            `OAuth client ID looks like a client secret for ${client.name}`,
          );
          assert.ok(!JSON.stringify(error).includes(misplaced));
          assert.ok(!String(error.stack).includes(misplaced));
          return true;
        },
      );
    }
  }
});

test("release refuses malformed IDs even when the optional secret is absent", () => {
  assert.throws(
    () =>
      deployEnvironment({
        ...credentials(),
        EXECUTOR_OAUTH_PLANETSCALE_CLIENT_ID: "pscale_app_secret_synthetic-private-marker",
      }),
    /OAuth client ID looks like a client secret for PlanetScale/,
  );
});

test("release refuses secrets in the login clients too", () => {
  for (const field of ["GOOGLE_CLIENT_ID", "AUTH_GITHUB_CLIENT_ID"]) {
    assert.throws(
      () => deployEnvironment({ ...credentials(), [field]: "GOCSPX-synthetic-private-marker" }),
      { name: "OAuthClientConfigurationError" },
    );
  }
});

test("release accepts opaque IDs and the PlanetScale client ID prefix unchanged", () => {
  for (const clientId of ["pscale_app_synthetic-client", "opaque-client", "0123456789abcdef"]) {
    const configured = deployEnvironment({
      ...credentials(),
      EXECUTOR_OAUTH_PLANETSCALE_CLIENT_ID: clientId,
      EXECUTOR_OAUTH_PLANETSCALE_CLIENT_SECRET: "pscale_app_secret_synthetic-secret",
    });
    assert.equal(configured.EXECUTOR_OAUTH_PLANETSCALE_CLIENT_ID, clientId);
    assert.equal(configured.PLANETSCALE_CONNECTOR_READY, "true");
  }
});
