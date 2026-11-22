import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSsoRuntimeBundle, checkSsoRuntimeBundle } from "../sso-runtime-bundle.ts";

test("the production sso upload contains no API definition it serves no route of", () => {
  checkSsoRuntimeBundle();
});

test("the sso boundary rejects a retained API definition at any size", () => {
  for (const source of [
    "apps/hosted/server/src/contracts/api.ts",
    "apps/hosted/cloud/src/contracts/api.ts",
    "packages/app-management/src/contracts/api.ts",
  ]) {
    assert.throws(
      () => assertSsoRuntimeBundle({ worker: "sso", sources: { [source]: 1, "entry.ts": 100 } }),
      /must not upload an API definition it serves no route of/,
    );
  }
});

test("the sso boundary keeps the contracts sso uses and refuses a missing attribution", () => {
  assertSsoRuntimeBundle({
    worker: "sso",
    sources: {
      "apps/hosted/server/src/contracts/auth.ts": 1,
      "packages/mcp-auth/src/contracts/device.ts": 1,
    },
  });
  assert.throws(() => assertSsoRuntimeBundle({ worker: "sso", sources: {} }));
  assert.throws(() => assertSsoRuntimeBundle({ worker: "api", sources: { "entry.ts": 1 } }));
});
