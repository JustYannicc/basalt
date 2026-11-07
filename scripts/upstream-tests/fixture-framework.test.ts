import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appsManifest, appsVersion } from "../../.upstream/e2e/support/apps-release.ts";

test("the prepared test registry emits the host framework version", () => {
  const host = JSON.parse(
    readFileSync(new URL("../../.upstream/packages/apps/package.json", import.meta.url), "utf8"),
  );
  assert.equal(appsVersion, host.version);
  assert.equal(JSON.parse(appsManifest.content).dependencies.apps, host.version);
});
