import assert from "node:assert/strict";
import { test } from "node:test";
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
