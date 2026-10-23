import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brand } from "../brand.ts";
import { deployEnvironment, requiredSecrets } from "./environment.ts";

test("missing credentials fail with a name and never a value", () => {
  assert.throws(
    () => deployEnvironment({}),
    /Missing GitHub Actions secret: CLOUDFLARE_ACCOUNT_ID/,
  );
});

test("deploy maps login secrets and pins EU production without hosted emulators", () => {
  const source = Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"]));
  const env = deployEnvironment(source);
  assert.equal(env.GITHUB_CLIENT_SECRET, source.AUTH_GITHUB_CLIENT_SECRET);
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
  const env = deployEnvironment(Object.fromEntries(requiredSecrets.map((name) => [name, "fixture"])));
  assert.equal(env.EXECUTOR_PRODUCT_NAME, brand.name);
  assert.equal(env.EXECUTOR_PRODUCT_LOGO_URL, brand.logo);
  assert.equal(env.AUTH_EMAIL_DOMAIN, brand.emailDomain);
  // The router serves the logo; a rename that moves it must move the file too.
  assert.ok(existsSync(fileURLToPath(new URL(`../public${brand.logo}`, import.meta.url))));
});
