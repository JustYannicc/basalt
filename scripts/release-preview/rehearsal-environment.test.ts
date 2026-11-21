import assert from "node:assert/strict";
import { test } from "node:test";
import { rehearsalReleaseEnvironment } from "./rehearsal-environment.ts";

const source = {
  ALCHEMY_STAGE: "test-rehearsal-81211",
  CLOUDFLARE_ACCOUNT_ID: "1".repeat(32),
  CLOUDFLARE_API_TOKEN: "cloudflare-token",
  PLANETSCALE_ORGANIZATION: "organization",
  PLANETSCALE_API_TOKEN_ID: "token-id",
  PLANETSCALE_API_TOKEN: "planetscale-token",
  TEST_STAGE_DOMAIN: "example.invalid",
  GOOGLE_CLIENT_ID: "google-client",
  AUTH_GITHUB_CLIENT_ID: "github-client",
  PREVIEW_STATE_KEY: "a".repeat(64),
  PREVIEW_SMOKE_EMAIL: "smoke@example.invalid",
  PREVIEW_SMOKE_PASSWORD: "password",
  BASALT_RELEASE_CANDIDATE: "b".repeat(40),
  BASALT_REHEARSAL_STOP: "after-adopt",
  PREVIEW_AUTH_SEED_OUTPUT: "/private/seed-1.json",
  GITHUB_ACTIONS: "true",
  GITHUB_JOB: "rehearsal",
  RELEASE_REHEARSAL_SENTRY_DSN: "https://key@o1.ingest.de.sentry.io/2",
  // Production's own values never reach a rehearsal release.
  POOL_DEPLOYMENT_KEY: "production-deployment-key",
  POOL_APP_SIGNING_KEY: "production-signing-key",
  SENTRY_DSN: "https://production@o1.ingest.de.sentry.io/3",
};

test("a rehearsal release carries its stage, seed and release controls, and none of production's keys", () => {
  const env = rehearsalReleaseEnvironment({ ...source, POOL_AVAILABILITY_TARGET: "app_clean" });
  assert.equal(env.ALCHEMY_STAGE, "test-rehearsal-81211");
  assert.equal(env.TEST_STAGE_DATABASE, "basalt-preview-rehearsal-81211");
  assert.equal(env.PREVIEW_SMOKE_EMAIL, "smoke@example.invalid");
  assert.equal(env.PREVIEW_AUTH_SEED_OUTPUT, "/private/seed-1.json");
  assert.equal(env.BASALT_RELEASE_CANDIDATE, "b".repeat(40));
  assert.equal(env.BASALT_REHEARSAL_STOP, "after-adopt");
  assert.equal(env.POOL_AVAILABILITY_TARGET, "app_clean");
  assert.equal(env.SENTRY_DSN, source.RELEASE_REHEARSAL_SENTRY_DSN);
  assert.notEqual(env.POOL_DEPLOYMENT_KEY, source.POOL_DEPLOYMENT_KEY);
  assert.notEqual(env.POOL_APP_SIGNING_KEY, source.POOL_APP_SIGNING_KEY);
  assert.match(env.POOL_DEPLOYMENT_KEY ?? "", /^[a-f0-9]{64}$/);
});

test("a rehearsal release refuses production's stage, other stages, and a target without its own Sentry", () => {
  for (const stage of ["production", "test-pr-12", undefined])
    assert.throws(
      () => rehearsalReleaseEnvironment({ ...source, ALCHEMY_STAGE: stage }),
      /rehearsal stage/,
    );
  assert.throws(
    () =>
      rehearsalReleaseEnvironment({
        ...source,
        POOL_AVAILABILITY_TARGET: "app_clean",
        RELEASE_REHEARSAL_SENTRY_DSN: "",
      }),
    /RELEASE_REHEARSAL_SENTRY_DSN/,
  );
  assert.equal(rehearsalReleaseEnvironment(source).SENTRY_DSN === source.SENTRY_DSN, false);
});
