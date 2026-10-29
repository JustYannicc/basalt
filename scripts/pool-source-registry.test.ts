import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parsePatchManifestV3 } from "./releases/patch-registry.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("pool carries bind the exact source, patch bytes and manual retirement proof", () => {
  const registry = parsePatchManifestV3(read("scripts/releases/patches.json").toString());
  assert.ok(registry.pool_carries);
  const bytes = read(registry.pool_carries.manifest);
  assert.equal(digest(bytes), registry.pool_carries.content_sha256);
  const sources = JSON.parse(bytes.toString());
  const releases = JSON.parse(read("containers/pool/releases.json").toString());
  const files: string[] = [];
  for (const name of ["home", "node"]) {
    const artifact = sources.artifacts[name], release = releases.artifacts[name];
    assert.equal(artifact.commit, release.commit);
    assert.equal(artifact.repository, release.repository);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    for (const patch of artifact.patches) {
      assert.match(patch.identity, /^[a-z][a-z0-9-]+$/);
      assert.match(patch.file, /^[a-zA-Z0-9_.-]+\.patch$/);
      assert.equal(digest(read(`containers/pool/patches/${patch.file}`)), patch.sha256);
      assert.equal(patch.retirement.mode, "manual");
      assert.ok(patch.retirement.requires.includes("forced failure") && patch.retirement.requires.includes("purge"));
      files.push(patch.file);
    }
  }
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(files.sort(), readdirSync(new URL("containers/pool/patches/", root)).filter((file) => file.endsWith(".patch")).sort());
});
