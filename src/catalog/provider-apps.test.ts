import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { providerAppLabs, providerAppSource } from "../../scripts/provider-app-source.ts";
import { providerApps } from "./provider-apps/index.ts";
import { handleCatalog } from "./worker.ts";
import type { Feed } from "./feed.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Supported providers publish installable sources with the canonical saved-account identity", async () => {
  const origin = "https://catalog.example.test";
  const feed = await (await handleCatalog(new Request(`${origin}/catalog/index.json`), async () =>
    Response.json({ version: 1, apps: [] }))).json() as Feed;
  for (const lab of providerAppLabs) {
    const entry = feed.apps.find((entry) => entry.id === `provider-${lab}`);
    assert.ok(entry, `${lab} is missing from Add app`);
    assert.match(entry.description, /pools/);
    assert.ok(entry.icons.length > 0);
    const response = await handleCatalog(new Request(`${origin}/catalog/${entry.source}`), async () => {
      throw new Error("Provider app sources must not come from another publisher");
    });
    assert.equal(response.status, 200);
    const source = await response.json();
    assert.deepEqual(source, providerAppSource(root, lab));
    assert.equal(source.package, entry.package);
    const declaration = source.files.find((file: { path: string }) => file.path === "providers.ts");
    assert.ok(declaration, `${lab} is missing its provider declaration`);
    assert.equal(declaration.content, readFileSync(`${root}src/pool/provider-accounts/definitions.ts`, "utf8"));
  }
  assert.equal(providerApps.length, providerAppLabs.length);
});
