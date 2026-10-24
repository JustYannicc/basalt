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
  assert.equal(absent.ATLASSIAN_CONNECTOR_READY, "false");
  const configured = deployEnvironment({
    ...credentials,
    EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID: "fixture-atlassian-client",
    EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET: "fixture-atlassian-secret",
  });
  assert.equal(configured.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID, "fixture-atlassian-client");
  assert.equal(configured.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET, "fixture-atlassian-secret");
  assert.equal(configured.ATLASSIAN_CONNECTOR_READY, "true");
  assert.equal(configured.EXECUTOR_CATALOG_URL, "https://app.signalbox.run/catalog/index.json");
});

test("a partial Atlassian client removes both halves before the host sees them", () => {
  for (const name of ["EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID", "EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET"]) {
    const environment = deployEnvironment({ ...credentials, [name]: "fixture-private-value" });
    assert.equal(environment.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID, undefined);
    assert.equal(environment.EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET, undefined);
    assert.equal(environment.ATLASSIAN_CONNECTOR_READY, "false");
  }
});
