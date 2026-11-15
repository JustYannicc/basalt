import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCatalog, previewCatalogAcceptance } from "./worker.ts";
import type { Feed } from "./feed.ts";

const head = "a".repeat(40);
const publisher: typeof fetch = async () => Response.json({ version: 1, apps: [] });

test("retired compile acceptance sources and witnesses are limited to the provisioned PR preview", async () => {
  const accepted = previewCatalogAcceptance({
    BASALT_COMPILER_PREVIEW_STAGE: "test-pr-42",
    BASALT_COMPILER_PREVIEW_HEAD: head,
  });
  assert.deepEqual(accepted, { head });
  for (const env of [
    {},
    { BASALT_COMPILER_PREVIEW_STAGE: "production", BASALT_COMPILER_PREVIEW_HEAD: head },
    { BASALT_COMPILER_PREVIEW_STAGE: "test-pr-42" },
    { BASALT_COMPILER_PREVIEW_STAGE: "test-pr-42", BASALT_COMPILER_PREVIEW_HEAD: "main" },
  ])
    assert.equal(previewCatalogAcceptance(env), undefined);
  for (const acceptance of [undefined, accepted]) {
    const response = await handleCatalog(
      new Request("https://catalog.example.test/catalog/index.json"),
      publisher,
      undefined,
      acceptance,
    );
    const feed = (await response.json()) as Feed;
    assert.equal(
      feed.apps.some((entry) => entry.id === "gitlab-mcp"),
      acceptance !== undefined,
    );
    assert.equal(
      feed.apps.some((entry) => entry.id === "atlassian"),
      false,
    );
    assert.equal(
      response.headers.get("x-basalt-preview-head"),
      acceptance === undefined ? null : head,
    );
    const source = await handleCatalog(
      new Request("https://catalog.example.test/catalog/apps/gitlab-mcp.json"),
      publisher,
      undefined,
      acceptance,
    );
    assert.equal(source.status, 200);
    assert.equal(
      source.headers.get("x-basalt-preview-compiler-cache-mode"),
      acceptance === undefined ? null : "cold",
    );
    assert.equal(
      source.headers.get("cache-control"),
      acceptance === undefined ? "public, max-age=300" : "no-store",
    );
  }
});
