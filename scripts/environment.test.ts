import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brand } from "../brand.ts";
import { connectorWarnings, deployEnvironment, optionalConnectorClients, requiredSecrets } from "./environment.ts";

test("missing credentials fail with a name and never a value", () => {
  assert.throws(
    () => deployEnvironment({}),
    /Missing GitHub Actions secret: CLOUDFLARE_ACCOUNT_ID/,
  );
});

test("deploy maps login secrets and pins EU production without hosted emulators", () => {
  const source = Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"]));
  source.POOL_APP_SIGNING_KEY = "ab".repeat(32);
  const env = deployEnvironment(source);
  assert.equal(env.GITHUB_CLIENT_SECRET, source.AUTH_GITHUB_CLIENT_SECRET);
  assert.equal(env.POOL_APP_SIGNING_KEY, source.POOL_APP_SIGNING_KEY);
  assert.equal(env.EXECUTOR_APPS_VERSION, "0.0.1-beta.104-basalt.1");
  assert.ok(env.EXECUTOR_APPS_FRAMEWORK!.endsWith("/.upstream/.local/basalt-framework"));
  assert.equal(env.BETTER_AUTH_URL, "https://app.signalbox.run");
  assert.equal(env.ALCHEMY_STAGE, "production");
  assert.equal(env.PLANETSCALE_REGION, "eu-central");
  assert.equal(env.PLANETSCALE_ADOPT_DATABASE, "true");
  assert.equal(env.EXECUTOR_ENCRYPTED_WORKFLOW_STARTS, "true");
  assert.equal(env.EXECUTOR_EMULATORS, undefined);
  assert.equal(env.TEST_STAGE_DATABASE_PROVIDER, undefined);
  assert.match(env.EXECUTOR_BUILD_VERSION!, /^[a-f0-9]{40}$/);
});

test("production rejects emulator and foreign hosting overrides", () => {
  const credentials = Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"]));
  credentials.POOL_APP_SIGNING_KEY = "ab".repeat(32);
  for (const name of [
    "EXECUTOR_EMULATORS",
    "TEST_STAGE_DATABASE_PROVIDER",
    "EXECUTOR_ROLE_HOSTS_DOMAIN",
  ]) {
    assert.throws(
      () => deployEnvironment({ ...credentials, [name]: "set" }),
      /Unsupported production override/,
    );
  }
  assert.equal(deployEnvironment(credentials).EXECUTOR_APP_UI_BASE_URL, undefined);
});

test("deploys hand the brand's name and logo to the tools service", () => {
  const env = deployEnvironment({
    ...Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"])),
    POOL_APP_SIGNING_KEY: "0".repeat(64),
  });
  assert.equal(env.EXECUTOR_PRODUCT_NAME, brand.name);
  assert.equal(env.EXECUTOR_PRODUCT_LOGO_URL, brand.logo);
  assert.equal(env.AUTH_EMAIL_DOMAIN, brand.emailDomain);
  assert.equal(env.EXECUTOR_PRODUCT_DOCS_URL, brand.links.docs ?? undefined);
  assert.equal(env.EXECUTOR_PRODUCT_PRIVACY_URL, brand.links.privacy ?? undefined);
  assert.equal(env.EXECUTOR_PRODUCT_TERMS_URL, brand.links.terms ?? undefined);
  // The router serves the logo; a rename that moves it must move the file too.
  assert.ok(existsSync(fileURLToPath(new URL(`../public${brand.logo}`, import.meta.url))));
});

test("the brand's own links are absolute, so the router never redirects a path to itself", () => {
  for (const [name, link] of Object.entries(brand.links)) {
    if (link !== null) assert.match(link, /^https?:\/\//, name);
  }
});

test("pool signing key is required and malformed values are never printed", () => {
  const credentials = Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"]));
  assert.throws(
    () => deployEnvironment({ ...credentials, POOL_APP_SIGNING_KEY: "" }),
    /Missing GitHub Actions secret: POOL_APP_SIGNING_KEY/,
  );
  assert.throws(() => deployEnvironment({ ...credentials, POOL_APP_SIGNING_KEY: "secret-value" }), {
    message: "POOL_APP_SIGNING_KEY must be 32 bytes of lowercase hex",
  });
});

test("a previous pool signing key is optional, hex, and never the current key", () => {
  const credentials = {
    ...Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"])),
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
  };
  assert.doesNotThrow(() => deployEnvironment(credentials));
  assert.doesNotThrow(() => deployEnvironment({ ...credentials, POOL_APP_SIGNING_KEY_PREVIOUS: "cd".repeat(32) }));
  assert.throws(() => deployEnvironment({ ...credentials, POOL_APP_SIGNING_KEY_PREVIOUS: "old-value" }), {
    message: "POOL_APP_SIGNING_KEY_PREVIOUS must be 32 bytes of lowercase hex",
  });
  assert.throws(() => deployEnvironment({ ...credentials, POOL_APP_SIGNING_KEY_PREVIOUS: `${"cd".repeat(32)}\n` }), {
    message: "POOL_APP_SIGNING_KEY_PREVIOUS must be 32 bytes of lowercase hex",
  });
  assert.throws(() => deployEnvironment({ ...credentials, POOL_APP_SIGNING_KEY_PREVIOUS: "ab".repeat(32) }), {
    message: "POOL_APP_SIGNING_KEY_PREVIOUS must differ from POOL_APP_SIGNING_KEY",
  });
});

test("optional telemetry destinations never block the first deployment", () => {
  assert.ok(!requiredSecrets.some((name: string) => ["SENTRY_DSN", "POSTHOG_PROJECT_KEY", "SENTRY_OTLP_ENDPOINT"].includes(name)));
  const credentials = {
    ...Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"])),
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
  };
  const disabled = deployEnvironment(credentials);
  assert.equal(disabled.SENTRY_DSN, undefined);
  assert.equal(disabled.POSTHOG_PROJECT_KEY, undefined);
  assert.equal(disabled.DO_NOT_TRACK, "1");
  assert.match(disabled.TELEMETRY_RELAY_KEY!, /^[a-f0-9]{64}$/);
  assert.notEqual(disabled.TELEMETRY_RELAY_KEY, credentials.POOL_APP_SIGNING_KEY);
  assert.equal(disabled.EXECUTOR_TELEMETRY_RELAY_TOKEN, disabled.TELEMETRY_RELAY_KEY);
  const configured = deployEnvironment({ ...credentials, SENTRY_DSN: "synthetic", POSTHOG_PROJECT_KEY: "synthetic" });
  assert.equal(configured.SENTRY_DSN, "synthetic");
  assert.equal(configured.POSTHOG_PROJECT_KEY, "synthetic");
  assert.equal(configured.DO_NOT_TRACK, "0");
});

test("connector credentials are separate from sign-in and the feed belongs to this deployment", () => {
  const source = {
    ...Object.fromEntries(requiredSecrets.map(name => [name, `fixture-${name}`])),
    ...Object.fromEntries(optionalConnectorClients.flatMap(client => [[client.id, `fixture-${client.id}`], [client.secret, `fixture-${client.secret}`]])),
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
  };
  const env = deployEnvironment(source);
  assert.equal(env.EXECUTOR_CATALOG_URL, "https://app.signalbox.run/catalog/index.json");
  assert.notEqual(env.GOOGLE_CLIENT_ID, env.EXECUTOR_OAUTH_GOOGLE_CLIENT_ID);
  assert.notEqual(env.GITHUB_CLIENT_ID, env.EXECUTOR_OAUTH_GITHUB_OAUTH_CLIENT_ID);
  assert.equal(env.GOOGLE_CONNECTOR_READY, "true");
  assert.equal(env.GITHUB_CONNECTOR_READY, "true");
  assert.deepEqual(connectorWarnings(env), []);
  for (const provider of ["GOOGLE", "GITHUB_OAUTH"]) {
    for (const part of ["ID", "SECRET"]) {
      const name = `EXECUTOR_OAUTH_${provider}_CLIENT_${part}`;
      assert.equal(env[name], source[name as keyof typeof source]);
      const missing = deployEnvironment({ ...source, [name]: "" });
      const client = optionalConnectorClients.find(client => client.id === name || client.secret === name)!;
      assert.equal(missing[client.id], undefined);
      assert.equal(missing[client.secret], undefined);
      assert.equal(missing[client.ready], "false");
      assert.equal(connectorWarnings(missing).length, 1);
      assert.match(connectorWarnings(missing)[0]!, new RegExp(client.name));
    }
  }
});

test("absent optional connector clients do not block sign-in, pools or setup", () => {
  const source: NodeJS.ProcessEnv = { ...Object.fromEntries(requiredSecrets.map(name => [name, "fixture"])), POOL_APP_SIGNING_KEY: "ab".repeat(32) };
  const env = deployEnvironment(source);
  assert.equal(env.GOOGLE_CLIENT_ID, source.GOOGLE_CLIENT_ID);
  assert.equal(env.GITHUB_CLIENT_SECRET, source.AUTH_GITHUB_CLIENT_SECRET);
  assert.equal(env.POOL_APP_SIGNING_KEY, source.POOL_APP_SIGNING_KEY);
  assert.equal(env.GOOGLE_CONNECTOR_READY, "false");
  assert.equal(env.GITHUB_CONNECTOR_READY, "false");
  assert.equal(connectorWarnings(env).length, optionalConnectorClients.length);
  assert.ok(connectorWarnings(env).every(warning => warning.includes("not set up yet") && !warning.includes("fixture")));
});
