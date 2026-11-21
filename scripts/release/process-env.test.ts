import assert from "node:assert/strict";
import { test } from "node:test";
import { assignEnvironment } from "./process-env.ts";

test("an unset setting is removed, never stored as the text undefined", () => {
  const target: Record<string, string | undefined> = { EXECUTOR_PRODUCT_DOCS_URL: "stale" };
  assignEnvironment(target, {
    EXECUTOR_PRODUCT_DOCS_URL: undefined,
    EXECUTOR_OAUTH_NOTION_CLIENT_ID: undefined,
    CLOUDFLARE_ACCOUNT_ID: "a",
  });
  assert.deepEqual(target, { CLOUDFLARE_ACCOUNT_ID: "a" });
  // What Object.assign did before: process.env keeps the text, so Workers got "undefined" as a URL.
  const env = { ...process.env };
  try {
    Object.assign(process.env, { BASALT_PROCESS_ENV_PROBE: undefined });
    assert.equal(process.env.BASALT_PROCESS_ENV_PROBE, "undefined");
    assignEnvironment(process.env, { BASALT_PROCESS_ENV_PROBE: undefined });
    assert.equal("BASALT_PROCESS_ENV_PROBE" in process.env, false);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  }
});
