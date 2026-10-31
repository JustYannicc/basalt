import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pluginOAuthProviderIds } from "./pool-plugin-providers.ts";

function manifest(root: string, plugins: unknown) {
  mkdirSync(join(root, "containers/pool"), { recursive: true });
  writeFileSync(join(root, "containers/pool/sources.json"), JSON.stringify({ format_version: 1, plugins }));
}

test("plugin login inventory follows auth IDs independently of the plugin name", (context) => {
  const root = mkdtempSync(join(tmpdir(), "pool-plugin-providers-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  manifest(root, { bundle: { auth_providers: ["fixture-login", "fixture-region"] } });
  assert.deepEqual(pluginOAuthProviderIds(root), ["fixture-login", "fixture-region"]);
  manifest(root, {});
  assert.deepEqual(pluginOAuthProviderIds(root), []);
});

test("undeclared, invalid and duplicated plugin auth IDs cannot enter the login inventory", (context) => {
  const root = mkdtempSync(join(tmpdir(), "pool-plugin-providers-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const plugins of [{ bundle: {} }, { bundle: { auth_providers: ["../invalid"] } },
    { first: { auth_providers: ["same"] }, second: { auth_providers: ["same"] } }]) {
    manifest(root, plugins);
    assert.throws(() => pluginOAuthProviderIds(root), /auth provider/);
  }
});
