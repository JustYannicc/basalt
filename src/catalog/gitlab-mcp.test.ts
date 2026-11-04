import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import type { Feed } from "./feed.ts";

test("GitLab MCP installs from the catalog without replacing the REST app", async () => {
  const publisher: typeof fetch = async () => Response.json({ version: 1, apps: [{
    id: "gitlab", package: "@executor.sh/gitlab", name: "GitLab", description: "REST",
    source: "apps/gitlab.json", icons: [], auth: [],
  }] });
  const response = await handleCatalog(new Request("https://example.invalid/catalog/index.json"), publisher);
  assert.equal(response.status, 200);
  const feed = await response.json() as Feed;
  assert.equal(feed.apps.filter((entry) => entry.id === "gitlab").length, 1);
  const mcp = feed.apps.find((entry) => entry.id === "gitlab-mcp");
  assert.ok(mcp);
  const installed = await handleCatalog(new Request(`https://example.invalid/catalog/${mcp.source}`), async () => {
    throw new Error("The carried app must not fetch an external source");
  });
  assert.equal(installed.status, 200);
  const source = await installed.json() as { package: string; files: { path: string; content: string }[] };
  assert.equal(source.package, mcp.package);
  assert.ok(source.files.some((file) => file.path === "index.ts"));
  const manifest = source.files.find((file) => file.path === "package.json");
  assert.ok(manifest);
  assert.equal(JSON.parse(manifest.content).name, mcp.package);
});
