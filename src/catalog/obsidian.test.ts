import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Feed } from "./feed.ts";
import { handleCatalog } from "./worker.ts";

const origin = "https://catalog.example.test";

test("the public catalog lists Obsidian with an installable source", async () => {
  const response = await handleCatalog(new Request(`${origin}/catalog/index.json`), async () =>
    Response.json({ version: 1, apps: [] }),
  );
  assert.equal(response.status, 200);
  const feed = (await response.json()) as Feed;
  const entries = feed.apps.filter((entry) => entry.id === "obsidian");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, "Obsidian");
  assert.equal(entries[0]!.source, "apps/obsidian.json");
});

test("Obsidian catalog installation receives every shipped app file without another publisher", async () => {
  const request = new Request(`${origin}/catalog/apps/obsidian.json`);
  const response = await handleCatalog(request, async () => {
    throw new Error("Obsidian source must be supplied by this release");
  });
  assert.equal(response.status, 200);
  const directory = fileURLToPath(new URL("../../apps/obsidian", import.meta.url));
  const files = readdirSync(directory)
    .sort()
    .map((path) => ({ path, content: readFileSync(join(directory, path), "utf8") }));
  assert.deepEqual(await response.json(), { package: "obsidian", files });
  const head = await handleCatalog(new Request(request, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
