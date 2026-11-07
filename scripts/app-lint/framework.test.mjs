import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { servedFrameworkVersion } from "../../framework-release.ts";
import { onServedFramework } from "../../src/catalog/framework.ts";
import { hostVersion } from "./host.mjs";
import { discoverApps } from "./source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const version = hostVersion(root);
const repositories = JSON.parse(
  readFileSync(new URL("../catalog-sources.json", import.meta.url), "utf8"),
);
const frozenPackages = new Set(repositories.apps.map((app) => app.package));

test("the carried host framework matches the served release", () => {
  assert.equal(servedFrameworkVersion, version);
});

test("every maintained publisher and direct-install catalog pins the prepared host framework", () => {
  assert.equal(servedFrameworkVersion, version);
  const mismatches = [];
  for (const app of discoverApps(root, (text) => {
    // Source repositories retain their captured release; publication maps it to the host.
    return frozenPackages.has(JSON.parse(text).package) ? onServedFramework(text) : text;
  })) {
    const file = app.files.find((file) => file.path === "package.json");
    assert.ok(file?.bytes, `${app.name} has no package.json`);
    const pin = JSON.parse(file.bytes.toString("utf8")).dependencies?.apps;
    if (pin !== version)
      mismatches.push(`${app.name} package.json dependencies.apps: ${String(pin)} -> ${version}`);
  }
  assert.deepEqual(mismatches, [], "Publishers must declare the prepared host framework");
});
