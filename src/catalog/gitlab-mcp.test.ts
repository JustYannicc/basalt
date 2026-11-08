import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import type { Feed } from "./feed.ts";

test("GitLab lists one app while installed GitLab MCP copies keep their source", async () => {
  const publisher: typeof fetch = async () =>
    Response.json({
      version: 1,
      apps: [
        {
          id: "gitlab",
          package: "@executor.sh/gitlab",
          name: "GitLab",
          description: "REST",
          source: "apps/gitlab.json",
          icons: [],
          auth: [],
        },
      ],
    });
  const response = await handleCatalog(
    new Request("https://example.invalid/catalog/index.json"),
    publisher,
  );
  assert.equal(response.status, 200);
  const feed = (await response.json()) as Feed;
  assert.deepEqual(
    feed.apps.filter((entry) => /gitlab/i.test(entry.id)).map((entry) => entry.id),
    ["gitlab"],
  );
  const installed = await handleCatalog(
    new Request("https://example.invalid/catalog/apps/gitlab-mcp.json"),
    async () => {
      throw new Error("The carried app must not fetch an external source");
    },
  );
  assert.equal(installed.status, 200);
  const source = (await installed.json()) as {
    package: string;
    files: { path: string; content: string }[];
  };
  assert.equal(source.package, "@signalbox/gitlab-mcp");
  assert.ok(source.files.some((file) => file.path === "index.ts"));
});
