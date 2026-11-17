import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exaSource } from "./exa.ts";
import { onServedFramework } from "./framework.ts";
import { handleCatalog } from "./worker.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = (suffix: string) => readFileSync(new URL(`./exa.${suffix}`, import.meta.url));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

test("Exa's corrected package serves without its publisher and replays exactly", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/exa.json"),
    async () => {
      throw new Error("Publisher unavailable");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), JSON.parse(onServedFramework(JSON.stringify(exaSource))));
  const provenance = JSON.parse(bytes("provenance.json").toString());
  assert.equal(sha(bytes("published.json")), provenance.publishedSha256);
  assert.equal(sha(bytes("json")), provenance.carriedSha256);
  assert.equal(sha(bytes("patch")), provenance.patchSha256);
  const manifest = JSON.parse(
    exaSource.files.find((file) => file.path === "package.json")!.content,
  );
  assert.equal(manifest.dependencies.apps, provenance.appsVersion);
  const original: typeof exaSource = JSON.parse(bytes("published.json").toString());
  const directory = mkdtempSync(join(tmpdir(), "exa-replay-"));
  try {
    for (const file of original.files) writeFileSync(join(directory, file.path), file.content);
    execFileSync("git", ["apply", new URL("./exa.patch", import.meta.url).pathname], {
      cwd: directory,
    });
    for (const file of exaSource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Exa checks keys on the Websets server, refuses only on 401/403 and reads as queries", () => {
  const output = execFileSync(
    "bun",
    [new URL("./tests/exa-runtime.mjs", import.meta.url).pathname, root],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(output, /every generated operation's kind PASS/);
});
