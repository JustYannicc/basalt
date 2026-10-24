import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brand } from "../brand.ts";
import {
  connectorWarnings,
  optionalConnectorClients,
  deployEnvironment,
  previewCleanupEnvironment,
  previewEnvironment,
  requiredPreviewDeploySecrets,
  requiredPreviewSecrets,
  requiredSecrets,
} from "./environment.ts";

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
    "TEST_STAGE_PASSWORD_SIGN_IN",
    "PREVIEW_STATE_KEY",
    "PREVIEW_SMOKE_EMAIL",
    "PREVIEW_SMOKE_PASSWORD",
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

test("preview environment is per-PR, isolated, and keeps smoke credentials deploy-only", () => {
  const source = Object.fromEntries(requiredPreviewDeploySecrets.map((name) => [name, "fixture"]));
  Object.assign(source, {
    TEST_STAGE_DOMAIN: "preview.example.invalid",
    TEST_STAGE_DATABASE: "basalt-previews-must-not-be-used",
    PREVIEW_STATE_KEY: "12".repeat(32),
    PREVIEW_SMOKE_EMAIL: "preview-pr-1419@example.invalid",
    PREVIEW_SMOKE_PASSWORD: "fixed-preview-password",
    GOOGLE_CLIENT_SECRET: "production-google-secret-must-not-pass-through",
    AUTH_GITHUB_CLIENT_SECRET: "production-github-secret-must-not-pass-through",
    BETTER_AUTH_SECRET: "production-auth-secret-must-not-pass-through",
    POOL_MANAGEMENT_KEY: "production-pool-key-must-not-pass-through",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_APP_SIGNING_KEY_PREVIOUS: "cd".repeat(32),
    OAUTH_PROXY_SECRET: "production-proxy-secret-must-not-pass-through",
    PREVIEW_CLAUDE_AUTH_JSON: "private-claude-login",
    PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON: "private-codex-subscription",
    PREVIEW_CODEX_CLI_AUTH_JSON: "private-codex-native",
    EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: "private-production-connector",
    RELEASE_UPDATE_TOKEN: "private-repository-token",
    UNKNOWN_FUTURE_SECRET: "must-not-pass-through",
  });

  const first = previewEnvironment(1419, source);
  const retry = previewEnvironment(1419, source);
  const sibling = previewEnvironment(1420, source);

  assert.equal(first.stage, "test-pr-1419");
  assert.equal(first.sourceNamespace, "basalt-preview-pr-1419-apps");
  assert.equal(first.databaseName, "basalt-preview-pr-1419");
  assert.equal(first.origin, "https://app.pr-1419.preview.example.invalid");
  assert.equal(first.deploy.TEST_STAGE_DATABASE_PROVIDER, "planetscale");
  assert.equal(first.deploy.TEST_STAGE_DATABASE, "basalt-preview-pr-1419");
  assert.equal(first.deploy.TEST_STAGE_PASSWORD_SIGN_IN, "true");
  assert.equal(first.deploy.PLANETSCALE_ADOPT_DATABASE, "false");
  assert.equal(first.deploy.PREVIEW_SMOKE_EMAIL, undefined);
  assert.equal(first.deploy.PREVIEW_SMOKE_PASSWORD, undefined);
  assert.equal(first.deploy.PREVIEW_STATE_KEY, undefined);
  for (const key of ["PREVIEW_CLAUDE_AUTH_JSON", "PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON",
    "PREVIEW_CODEX_CLI_AUTH_JSON", "EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET", "RELEASE_UPDATE_TOKEN", "UNKNOWN_FUTURE_SECRET"])
    assert.equal(first.deploy[key], undefined, key);
  assert.equal(first.deploy.EXECUTOR_CATALOG_URL, `${first.origin}/catalog/index.json`);
  assert.match(first.deploy.TELEMETRY_RELAY_KEY!, /^[a-f0-9]{64}$/);
  assert.notEqual(first.deploy.TELEMETRY_RELAY_KEY, first.deploy.POOL_APP_SIGNING_KEY);
  assert.equal(first.deploy.EXECUTOR_TELEMETRY_RELAY_URL, `${first.origin}/__telemetry/v1`);
  assert.equal(first.deploy.EXECUTOR_TELEMETRY_RELAY_TOKEN, first.deploy.TELEMETRY_RELAY_KEY);
  assert.equal(first.deploy.SENTRY_DSN, undefined);
  assert.equal(first.deploy.POSTHOG_PROJECT_KEY, undefined);

  assert.equal(first.deploy.POOL_APP_SIGNING_KEY_PREVIOUS, undefined);
  for (const name of [
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_SECRET",
    "AUTH_GITHUB_CLIENT_SECRET",
    "BETTER_AUTH_SECRET",
    "OAUTH_PROXY_SECRET",
  ]) assert.doesNotMatch(first.deploy[name] ?? "", /production-.*secret-must-not-pass-through/);
  assert.equal(first.deploy.POOL_MANAGEMENT_KEY, retry.deploy.POOL_MANAGEMENT_KEY);
  assert.notEqual(first.deploy.POOL_MANAGEMENT_KEY, sibling.deploy.POOL_MANAGEMENT_KEY);
  assert.notEqual(first.deploy.POOL_APP_SIGNING_KEY, source.POOL_APP_SIGNING_KEY);
  assert.equal(first.seed.PREVIEW_SMOKE_EMAIL, source.PREVIEW_SMOKE_EMAIL);
  assert.equal(first.seed.PREVIEW_SMOKE_PASSWORD, source.PREVIEW_SMOKE_PASSWORD);
  assert.equal(first.seed.BETTER_AUTH_SECRET, undefined);
});

test("preview config rejects unsafe PRs, hostnames, keys and real-person smoke accounts", () => {
  const source = {
    ...Object.fromEntries(requiredPreviewDeploySecrets.map((name) => [name, "fixture"])),
    TEST_STAGE_DOMAIN: "preview.example.invalid",
    TEST_STAGE_DATABASE: "basalt-previews-must-not-be-used",
    PREVIEW_STATE_KEY: "12".repeat(32),
    PREVIEW_SMOKE_EMAIL: "preview@example.invalid",
    PREVIEW_SMOKE_PASSWORD: "fixed-preview-password",
  };
  for (const number of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => previewEnvironment(number, source), /positive integer/);
  for (const TEST_STAGE_DOMAIN of ["https://preview.example.invalid", "preview.example.invalid/path", "bad zone"])
    assert.throws(() => previewEnvironment(1, { ...source, TEST_STAGE_DOMAIN }), /DNS zone name/);
  assert.throws(
    () => previewEnvironment(1, { ...source, PREVIEW_STATE_KEY: "secret" }),
    /32 bytes of lowercase hex/,
  );
  assert.throws(
    () => previewEnvironment(1, { ...source, PREVIEW_SMOKE_EMAIL: "person@example.test" }),
    /reserved example.invalid/,
  );
});

test("cleanup environment needs provider credentials and state key, never smoke credentials", () => {
  const source = {
    ...Object.fromEntries(requiredPreviewSecrets.map((name) => [name, "fixture"])),
    TEST_STAGE_DOMAIN: "preview.example.invalid",
    PREVIEW_STATE_KEY: "34".repeat(32),
  };
  const cleanup = previewCleanupEnvironment(1419, source);
  assert.equal(cleanup.stage, "test-pr-1419");
  assert.equal(cleanup.providers.ALCHEMY_STAGE, "test-pr-1419");
  assert.equal(cleanup.providers.POOL_APP_SIGNING_KEY, undefined);
  assert.equal(cleanup.providers.PREVIEW_SMOKE_EMAIL, undefined);
  assert.equal(cleanup.providers.PREVIEW_SMOKE_PASSWORD, undefined);
  assert.equal(cleanup.providers.PREVIEW_STATE_KEY, undefined);
  assert.throws(
    () => previewCleanupEnvironment(1419, { ...source, PREVIEW_STATE_KEY: undefined }),
    /Missing GitHub Actions secret: PREVIEW_STATE_KEY/,
  );
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
  assert.equal(connectorWarnings(env).length, 2);
  assert.ok(connectorWarnings(env).every(warning => warning.includes("not set up yet") && !warning.includes("fixture")));
});
