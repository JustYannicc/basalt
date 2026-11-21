import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  onReleasePath,
  releasePathChange,
  releasePathHash,
  releasePaths,
  releasePathsAt,
  unionOfPaths,
} from "./release-path.ts";
import { measured, root } from "./test/history.ts";

test("release path covers release code, workflows and Alchemy carries but not product code", () => {
  assert.equal(onReleasePath("scripts/release-barrier/runtime-image-release.ts"), true);
  assert.equal(onReleasePath("scripts/release/deploy.ts"), true);
  assert.equal(onReleasePath("patches/0370-alchemy-worker-upload-hook.patch"), true);
  assert.equal(onReleasePath(".github/workflows/release.yml"), true);
  assert.equal(onReleasePath("alchemy.run.ts"), true);
  assert.equal(onReleasePath("src/pool/fleet-deployment.ts"), true);
  assert.equal(onReleasePath("src/pool/worker.ts"), false);
  assert.equal(onReleasePath("patches/0006-product-brand.patch"), false);
  assert.equal(onReleasePath("scripts/releases/patches.json"), false);
});

test("every carry that patches Alchemy is on the release path, whatever its name", () => {
  const alchemy = /^diff --git a\/patches\/alchemy@[^\s]+\.patch /mu;
  for (const file of readdirSync(join(root, "patches")).filter((name) => name.endsWith(".patch")))
    if (alchemy.test(readFileSync(join(root, "patches", file), "utf8")))
      assert.equal(onReleasePath(`patches/${file}`), true, file);
});

test("every script the new release workflows run is on the release path", () => {
  // The old workflows are being removed with the layer they run; the new ones must stay covered.
  for (const workflow of [".github/workflows/release.yml", ".github/workflows/pool-fleet.yml"]) {
    let text: string;
    try {
      text = readFileSync(join(root, workflow), "utf8");
    } catch {
      continue; // Lands with the Alchemy release path.
    }
    for (const [script] of text.matchAll(/scripts\/[\w./-]+\.[cm]?[jt]s/gu))
      assert.equal(onReleasePath(script), true, `${workflow} runs ${script}`);
  }
});

test("the 16 Nov candidate replaced the release path of the last good release", () => {
  assert.notEqual(
    releasePathHash(root, "dae3b327", measured),
    releasePathHash(root, "0ae42a54", measured),
  );
  assert.deepEqual(releasePathChange(root, "0ae42a54", "dae3b327", measured), {
    files: 127,
    added: 9597,
    removed: 681,
  });
  // By the 18 Nov candidate it had grown by another 18,800 lines while every release failed.
  assert.deepEqual(releasePathChange(root, "0ae42a54", "5c68c6ab", measured), {
    files: 275,
    added: 28397,
    removed: 1693,
  });
});

test("the 6 Nov failure that started the first spiral also changed the release path", () => {
  assert.deepEqual(releasePathChange(root, "a637b6de", "a67568a6", measured), {
    files: 5,
    added: 174,
    removed: 34,
  });
});

test("the hash depends only on release-path files", () => {
  // d5ec45e5 failed on 11 Nov with the same release path as 0ae1d1eb, the good release before it.
  assert.equal(
    releasePathHash(root, "d5ec45e5", measured),
    releasePathHash(root, "0ae1d1eb", measured),
  );
  assert.notEqual(
    releasePathHash(root, "d5ec45e5", measured),
    releasePathHash(root, "0ae42a54", measured),
  );
});

test("a commit from before the list existed has an empty list, and lists combine", () => {
  assert.deepEqual(releasePathsAt(root, "0ae42a54"), []);
  assert.deepEqual(unionOfPaths(["a"], ["a", "b"]), ["a", "b"]);
  assert.ok(unionOfPaths(releasePaths, []).includes("scripts/release/**"));
});
