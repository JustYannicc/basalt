import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { handleCatalog } from "./worker.ts";
import { miroSource } from "./miro.ts";

test("Miro serves the board-only source without publisher access", async () => {
  const response = await handleCatalog(new Request("https://catalog.example.test/catalog/apps/miro.json"),
    async () => { throw new Error("Carried Miro source must not require its publisher"); });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), miroSource);
  const head = await handleCatalog(new Request("https://catalog.example.test/catalog/apps/miro.json", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("Miro catalog offers personal OAuth first and keeps its token fallback", async () => {
  const official = { version: 1, apps: [{ id: "miro", package: "@executor.sh/miro", name: "Miro",
    description: "Enterprise organization and team administration", auth: [{ method: "token", kind: "secrets" }],
    icons: [{ src: "icons/miro.svg" }], source: "apps/miro.json" }] };
  const response = await handleCatalog(new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json(official));
  assert.equal(response.status, 200);
  const feed = await response.json() as { apps: { id: string; auth: { method: string }[]; description: string;
    connectionNotices?: unknown }[] };
  const miro = feed.apps.find(app => app.id === "miro")!;
  assert.deepEqual(miro.auth.map(method => method.method), ["oauth", "token"]);
  assert.match(miro.description, /all plans/);
  assert.doesNotMatch(miro.description, /organization|team administration/);
  assert.equal(miro.connectionNotices, undefined);
});

test("Miro source provenance binds the published snapshot, local carry and framework", () => {
  const load = (name: string) => readFileSync(new URL(name, import.meta.url));
  const provenance = JSON.parse(load("./miro.provenance.json").toString());
  const digest = (name: string) => createHash("sha256").update(load(name)).digest("hex");
  assert.equal(digest("./miro.published.json"), provenance.publishedSha256);
  assert.equal(digest("./miro.json"), provenance.carriedSha256);
  assert.equal(digest("./miro.patch"), provenance.patchSha256);
  const manifest = JSON.parse(miroSource.files.find(file => file.path === "package.json")!.content);
  assert.equal(manifest.dependencies.apps, provenance.appsVersion);
});
