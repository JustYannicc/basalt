import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { recipeRoles, recipeSource } from "../../../scripts/recipe-sources.ts";
import { recipeAdditions } from "./index.ts";
import { handleCatalog } from "../worker.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));

test("the catalog serves complete editable recipes with the current framework and paused native schedules", async () => {
  const additions = recipeAdditions("https://installation.example");
  assert.equal(additions.length, 3);
  for (const role of recipeRoles) {
    const retained = JSON.parse(readFileSync(new URL(`./${role}.json`, import.meta.url), "utf8"));
    assert.deepEqual(retained, recipeSource(root, role));
  }
  for (const addition of additions) {
    const response = await handleCatalog(
      new Request(`https://installation.example/catalog/${addition.entry.source}`),
      async () => {
        throw new Error("Recipe source must not come from another publisher.");
      },
    );
    assert.equal(response.status, 200);
    const source = (await response.json()) as { files: Array<{ path: string; content: string }> };
    const installation = source.files.find(
      (file) => file.path === "common/installation.ts",
    )!.content;
    assert.match(installation, /origin = "https:\/\/installation.example"/);
    assert.ok(!installation.includes("https://app.signalbox.run"));
    assert.ok(
      source.files.some(
        (file) =>
          file.path === "migrations/0001_checkpoints.sql" && file.content.includes("DEFAULT 0"),
      ),
    );
    assert.ok(source.files.some((file) => file.path === "README.md"));
    assert.ok(!source.files.some((file) => /\.(test|spec)\./.test(file.path)));
  }
});
