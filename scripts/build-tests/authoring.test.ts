import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { decodeAuthoringFiles } from "../../.upstream/apps/hosted/cloud/src/authoring-files.ts";

test("authoring files retain exact Unicode text through the Worker asset encoding", async () => {
  const source = {
    "guide.md": "# Grüße\n\n東京 📁\n",
    "framework-reference.json": '{"version":"fixture"}',
  };
  assert.deepEqual(
    await decodeAuthoringFiles(gzipSync(JSON.stringify(source)).toString("base64")),
    source,
  );
  await assert.rejects(decodeAuthoringFiles(gzipSync('{"guide":42}').toString("base64")));
});

test("the built Worker exposes the exact published framework reference", async () => {
  const encoded: unknown = JSON.parse(
    await readFile(".upstream/apps/hosted/cloud/.generated/executor-authoring.json", "utf8"),
  );
  assert.equal(typeof encoded, "string");
  if (typeof encoded !== "string") throw new Error("Authoring data was not compressed");
  const files = await decodeAuthoringFiles(encoded);
  assert.deepEqual(
    JSON.parse(files["framework-reference.json"]!),
    JSON.parse(await readFile(".upstream/packages/apps/dist/framework-reference.json", "utf8")),
  );
});
