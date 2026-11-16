import assert from "node:assert/strict";
import { test } from "node:test";
import { lifecycleEnvironment, validateSmokeSecrets } from "./credentials.ts";

const source = {
  PREVIEW_SMOKE_EMAIL: "preview@example.invalid",
  PREVIEW_SMOKE_PASSWORD: "fixture-password",
  PREVIEW_POOL_ID: "fixture-pool",
  ORGANIZATION_ID: "fixture-org",
  OWNER_ID: "fixture-owner",
  POOL_APP_SIGNING_KEY: "ab".repeat(32),
  EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE: "true",
  BASALT_RELEASE_CANDIDATE: "a".repeat(40),
  UNKNOWN_FUTURE_SECRET: "private",
};
test("lifecycle children receive stage identity and no production pool authority", () => {
  const deploy = lifecycleEnvironment(source, "deploy");
  assert.equal(deploy.EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE, "true");
  assert.equal(deploy.BASALT_RELEASE_CANDIDATE, source.BASALT_RELEASE_CANDIDATE);
  assert.equal(deploy.PREVIEW_SMOKE_EMAIL, source.PREVIEW_SMOKE_EMAIL);
  const cleanup = lifecycleEnvironment(source, "cleanup");
  assert.equal(cleanup.EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE, undefined);
  for (const environment of [deploy, cleanup]) {
    for (const name of [
      "POOL_APP_SIGNING_KEY",
      "PREVIEW_POOL_ID",
      "ORGANIZATION_ID",
      "OWNER_ID",
      "UNKNOWN_FUTURE_SECRET",
    ])
      assert.equal(environment[name], undefined, name);
  }
});
test("preview requires the approved model-only pool inputs and synthetic stage identity", () => {
  validateSmokeSecrets(source);
  for (const name of [
    "PREVIEW_SMOKE_EMAIL",
    "PREVIEW_SMOKE_PASSWORD",
    "PREVIEW_POOL_ID",
    "ORGANIZATION_ID",
    "OWNER_ID",
    "POOL_APP_SIGNING_KEY",
  ]) {
    assert.throws(() => validateSmokeSecrets({ ...source, [name]: undefined }), new RegExp(name));
  }
  assert.throws(
    () => validateSmokeSecrets({ ...source, PREVIEW_SMOKE_EMAIL: "person@example.test" }),
    /reserved example.invalid/,
  );
  assert.throws(
    () => validateSmokeSecrets({ ...source, POOL_APP_SIGNING_KEY: "private-invalid-value" }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /signing key/);
      assert.doesNotMatch(error.message, /private-invalid-value/);
      return true;
    },
  );
});
