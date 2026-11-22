import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firecrawlSource } from "./firecrawl.ts";
import { onServedFramework } from "./framework.ts";
import { handleCatalog } from "./worker.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = (suffix: string) => readFileSync(new URL(`./firecrawl.${suffix}`, import.meta.url));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

test("Firecrawl's corrected package serves without its publisher and replays exactly", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/firecrawl.json"),
    async () => {
      throw new Error("Publisher unavailable");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(firecrawlSource))),
  );
  const provenance = JSON.parse(bytes("provenance.json").toString());
  assert.equal(sha(bytes("published.json")), provenance.publishedSha256);
  assert.equal(sha(bytes("json")), provenance.carriedSha256);
  assert.equal(sha(bytes("patch")), provenance.patchSha256);
  const manifest = JSON.parse(
    firecrawlSource.files.find((file) => file.path === "package.json")!.content,
  );
  assert.equal(manifest.dependencies.apps, provenance.appsVersion);
  const original: typeof firecrawlSource = JSON.parse(bytes("published.json").toString());
  const directory = mkdtempSync(join(tmpdir(), "firecrawl-replay-"));
  try {
    for (const file of original.files) writeFileSync(join(directory, file.path), file.content);
    execFileSync("git", ["apply", new URL("./firecrawl.patch", import.meta.url).pathname], {
      cwd: directory,
    });
    for (const file of firecrawlSource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Firecrawl reads modelled as POST are queries and every other write still asks", () => {
  const output = execFileSync(
    "bun",
    [new URL("./tests/firecrawl-runtime.mjs", import.meta.url).pathname, root],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(output, /Firecrawl generated operation kinds and approvals PASS/);
});
