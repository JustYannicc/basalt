import assert from "node:assert/strict";
import { test } from "node:test";
import { deployEnvironment, requiredSecrets } from "./environment.ts";

const credentials = {
  ...Object.fromEntries(requiredSecrets.map(name => [name, "fixture"])),
  POOL_APP_SIGNING_KEY: "ab".repeat(32),
};

test("deploy permits an unconfigured Atlassian client and forwards a configured pair", () => {
  const absent = deployEnvironment(credentials);
  assert.equal(absent.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID, undefined);
  assert.equal(absent.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET, undefined);
  const configured = deployEnvironment({
    ...credentials,
    EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID: "fixture-atlassian-client",
    EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET: "fixture-atlassian-secret",
  });
  assert.equal(configured.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID, "fixture-atlassian-client");
  assert.equal(configured.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET, "fixture-atlassian-secret");
  assert.equal(configured.EXECUTOR_CATALOG_URL, "https://app.signalbox.run/catalog/index.json");
});
