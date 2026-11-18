import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { onServedFramework } from "./framework.ts";
import { handleCatalog } from "./worker.ts";
import { googleSource } from "./google.ts";
import { catalog } from "./settings.ts";

const published = () =>
  JSON.parse(
    readFileSync(new URL("./google.published.json", import.meta.url), "utf8"),
  ) as typeof googleSource;
const carriedFiles = [
  "index.ts",
  "README.md",
  "curated.ts",
  "tools/gmail.ts",
  "tools/shared.ts",
  "tools/mime.ts",
  "tools/schedule.ts",
  "tools/calendar.ts",
  "tools/drive.ts",
  "tools/people.ts",
  "tools/sheets.ts",
  "tools/tasks.ts",
  "products/docs/tools.ts",
  "products/meet/tools.ts",
  "products/slides/tools.ts",
  "migrations/0001_scheduled_sends.sql",
];

test("Google GET and HEAD serve the local override without its publisher", async () => {
  const responses = [];
  for (const method of ["GET", "HEAD"]) {
    const response = await handleCatalog(
      new Request("https://catalog.example.test/catalog/apps/google.json", { method }),
      async () => {
        throw new Error("Must serve locally");
      },
    );
    assert.equal(response.status, 200);
    responses.push(response);
  }
  assert.equal(onServedFramework(JSON.stringify(googleSource)), JSON.stringify(googleSource));
  assert.equal(await responses[0]!.text(), JSON.stringify(googleSource));
  assert.equal(await responses[1]!.text(), "");
  assert.deepEqual([...responses[0]!.headers], [...responses[1]!.headers]);
});

test("Google keeps the published package except its carried files and host framework pin", () => {
  const bytes = (suffix: string) => readFileSync(new URL(`./google.${suffix}`, import.meta.url));
  const original = published();
  const provenance = JSON.parse(bytes("provenance.json").toString());
  for (const [suffix, key] of [
    ["published.json", "publishedSha256"],
    ["json", "carriedSha256"],
    ["patch", "patchSha256"],
  ] as const)
    assert.equal(createHash("sha256").update(bytes(suffix)).digest("hex"), provenance[key]);
  assert.deepEqual({ ...googleSource, files: [] }, { ...original, files: [] });
  assert.deepEqual(
    googleSource.files.map((file) => file.path).filter((path) => !carriedFiles.includes(path)),
    original.files.map((file) => file.path).filter((path) => !carriedFiles.includes(path)),
  );
  for (const file of original.files) {
    const carried = googleSource.files.find((candidate) => candidate.path === file.path)!;
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
    } else if (!carriedFiles.includes(file.path)) assert.deepEqual(carried, file);
  }
});

test("Google patch reproduces every carried file", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-google-carry-"));
  try {
    for (const file of published().files) {
      mkdirSync(dirname(join(directory, file.path)), { recursive: true });
      writeFileSync(join(directory, file.path), file.content);
    }
    execFileSync("git", ["apply", fileURLToPath(new URL("./google.patch", import.meta.url))], {
      cwd: directory,
    });
    for (const file of googleSource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content, file.path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Google's Gmail tools send attachments and schedule sends as served, against the published Google emulator", () => {
  assert.match(
    execFileSync("bun", ["scripts/connectors-tests/gmail-tools.mjs", "google"], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeout: 55_000,
    }),
    /checks passed against the published Google emulator/,
  );
});
