import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { onServedFramework } from "./framework.ts";
import { handleCatalog } from "./worker.ts";
import { notionSource } from "./notion.ts";
import { catalog } from "./settings.ts";

test("Notion GET and HEAD serve the local override without its publisher", async () => {
  const responses = [];
  for (const method of ["GET", "HEAD"]) {
    const response = await handleCatalog(
      new Request("https://catalog.example.test/catalog/apps/notion.json", { method }),
      async () => {
        throw new Error("Must serve locally");
      },
    );
    assert.equal(response.status, 200);
    responses.push(response);
  }
  assert.equal(onServedFramework(JSON.stringify(notionSource)), JSON.stringify(notionSource));
  assert.equal(await responses[0].text(), JSON.stringify(notionSource));
  assert.equal(await responses[1].text(), "");
  assert.deepEqual([...responses[0].headers], [...responses[1].headers]);
});

test("Notion preserves the published package except its account check and host framework pin", () => {
  const bytes = (suffix: string) => readFileSync(new URL(`./notion.${suffix}`, import.meta.url));
  const original = JSON.parse(bytes("published.json").toString()) as typeof notionSource;
  const provenance = JSON.parse(bytes("provenance.json").toString());
  for (const [suffix, key] of [
    ["published.json", "publishedSha256"],
    ["json", "carriedSha256"],
    ["patch", "patchSha256"],
  ])
    assert.equal(createHash("sha256").update(bytes(suffix)).digest("hex"), provenance[key]);
  assert.deepEqual({ ...notionSource, files: [] }, { ...original, files: [] });
  for (const file of original.files) {
    const carried = notionSource.files.find((candidate) => candidate.path === file.path)!;
    if (file.path === "package.json") {
      const publishedManifest = JSON.parse(file.content);
      const manifest = JSON.parse(carried.content);
      assert.equal(manifest.dependencies.apps, provenance.appsVersion);
      assert.equal(manifest.dependencies.apps, catalog.framework);
      assert.deepEqual(
        {
          ...manifest,
          dependencies: { ...manifest.dependencies, apps: publishedManifest.dependencies.apps },
        },
        publishedManifest,
      );
    } else if (!["index.ts", "README.md"].includes(file.path)) assert.deepEqual(carried, file);
  }
});

test("Notion patch reproduces every carried file including the full index", () => {
  const original = JSON.parse(
    readFileSync(new URL("./notion.published.json", import.meta.url), "utf8"),
  ) as typeof notionSource;
  const directory = mkdtempSync(join(tmpdir(), "basalt-notion-carry-"));
  try {
    for (const file of original.files) writeFileSync(join(directory, file.path), file.content);
    execFileSync("git", ["apply", fileURLToPath(new URL("./notion.patch", import.meta.url))], {
      cwd: directory,
    });
    assert.deepEqual(
      readdirSync(directory).sort(),
      notionSource.files.map((file) => file.path).sort(),
    );
    for (const file of notionSource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content, file.path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Notion account checks use synthetic REST and MCP peers", () => {
  assert.match(
    execFileSync("bun", ["src/catalog/notion-health.fixture.mjs"], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeout: 60_000,
    }),
    /health checks passed/,
  );
});
