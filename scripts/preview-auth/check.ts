import assert from "node:assert/strict";
import { productZone } from "../../.upstream/apps/hosted/cloud/src/infrastructure/stage.ts";
import { previewProof } from "./common.ts";

const stage = "test-pr-1419";
const domain = "example.invalid";
const origin = `https://app.${stage.slice(5)}.${domain}`;
const environment: NodeJS.ProcessEnv = {
  ALCHEMY_STAGE: stage,
  TEST_STAGE_DOMAIN: domain,
  BETTER_AUTH_URL: origin,
  TEST_STAGE_DATABASE_BRANCH: stage,
  TEST_STAGE_DATABASE_NAME: "preview_db",
  TEST_STAGE_DATABASE_USERNAME: "preview_role",
  DATABASE_URL: "postgresql://preview_role:private@db.example.test/preview_db?sslmode=verify-full",
  PREVIEW_SMOKE_EMAIL: "preview@example.invalid",
  PREVIEW_SMOKE_PASSWORD: "not-a-real-password-for-checks",
};

assert.equal(previewProof(environment, true).origin, origin);
assert.throws(() =>
  previewProof({ ...environment, BETTER_AUTH_URL: `https://${stage.slice(5)}.${domain}` }, true),
);
assert.throws(() => previewProof({ ...environment, ALCHEMY_STAGE: "v2" }, true));
assert.throws(() =>
  previewProof({ ...environment, TEST_STAGE_DATABASE_BRANCH: "test-pr-other" }, true),
);
assert.throws(() =>
  previewProof({ ...environment, BETTER_AUTH_URL: "https://v2.executor.sh" }, true),
);
assert.throws(() => previewProof({ ...environment, TEST_STAGE_DOMAIN: productZone }, true));
assert.throws(() =>
  previewProof(
    {
      ...environment,
      DATABASE_URL:
        "postgresql://preview_role:private@db.executor.sh/preview_db?sslmode=verify-full",
    },
    true,
  ),
);

console.log("Preview seed rejects production stage, origin, and database inputs.");
