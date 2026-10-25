import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the served Slack app pins the prepared host's framework release", () => {
  const source = JSON.parse(readFileSync(new URL("../../src/catalog/slack.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(source.files.find((file: { path: string }) => file.path === "package.json").content);
  const host = JSON.parse(readFileSync(new URL("../../.upstream/packages/apps/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies.apps, host.version);
});
