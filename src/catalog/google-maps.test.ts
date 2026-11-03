import { Effect } from "effect";
import { providerDeclaration } from "../../.upstream/packages/apps/src/implementation/host.ts";
import { createHostedRoutesProvider } from "./google-maps/hosted-routes.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import { googleMapsAddition } from "./google-maps/index.ts";
import { hostedRoutesProviderDefinition } from "./google-maps/provider.ts";
import { hostedRoutesProviderDefinition as hostDefinition } from "../../.upstream/apps/hosted/server/src/contracts/hosted-routes.ts";
import official from "./google-maps/source.json" with { type: "json" };

test("Maps source serves hosted Routes on this origin and preserves the official BYO APIs", async () => {
  const origin = "https://catalog.example.test";
  const response = await handleCatalog(new Request(`${origin}/catalog/apps/google-maps.json?origin=https://other.test`),
    async () => { throw new Error("The carried source must not fetch its publisher"); });
  assert.equal(response.status, 200);
  const served = await response.json() as typeof official;
  const byPath = new Map(served.files.map(file => [file.path, file.content]));
  for (const file of official.files) {
    if (["index.ts", "package.json", "README.md"].includes(file.path)) continue;
    assert.equal(byPath.get(file.path), file.content, `BYO source changed: ${file.path}`);
  }
  const originalIndex = official.files.find(file => file.path === "index.ts")!.content;
  const provider = originalIndex.slice(originalIndex.indexOf("const googleMaps ="), originalIndex.indexOf("export default defineApp"));
  assert.ok(byPath.get("index.ts")!.includes(provider), "The original BYO provider changed");
  assert.ok(byPath.get("index.ts")!.includes(`createHostedRoutesProvider("${origin}")`));
  assert.doesNotMatch(byPath.get("index.ts")!, /other\.test/);
  assert.equal(byPath.get("hosted-routes.ts"), readFileSync(new URL("./google-maps/hosted-routes.ts", import.meta.url), "utf8"));
  assert.equal(JSON.parse(byPath.get("package.json")!).dependencies.apps, "0.0.1-beta.104-basalt.1");
});

test("Maps catalog replaces the official listing once and rejects a changed package identity", async () => {
  const entry = googleMapsAddition("https://catalog.example.test").entry;
  const get = (packageName: string) => handleCatalog(new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [{ ...entry, package: packageName }] }));
  const response = await get(official.package);
  assert.equal(response.status, 200);
  const feed = await response.json() as { apps: { id: string }[] };
  assert.equal(feed.apps.filter(app => app.id === "google-maps").length, 1);
  assert.equal((await get("@other/maps")).status, 502);
});

test("The catalog and host agree on the exact sealed credential declaration, including local ports", () => {
  for (const origin of ["https://catalog.example.test", "http://127.0.0.1:4321"])
    assert.deepEqual(hostedRoutesProviderDefinition(origin), hostDefinition(origin));
});

test("The host identity matches the provider serialized by the app SDK", async () => {
  const origin = "https://catalog.example.test";
  assert.deepEqual(await Effect.runPromise(providerDeclaration(createHostedRoutesProvider(origin))), hostedRoutesProviderDefinition(origin));
});
