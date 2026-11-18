import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { onReleasePath, releasePathChange, releasePathHash } from "./release-path.ts";

const root = new URL("../..", import.meta.url).pathname;
const present = (commit: string) =>
  spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root }).status === 0;
const history = [
  "a637b6de",
  "a67568a6",
  "0ae42a54",
  "dae3b327",
  "5c68c6ab",
  "0ae1d1eb",
  "d5ec45e5",
].every(present);
const needsHistory = { skip: history ? false : "needs the full repository history" };
// The recorded numbers below were measured with this list; pinning it keeps them independent of later edits.
const measured = [
  "alchemy.run.ts",
  "release-declarations.json",
  "patches/*alchemy*",
  "scripts/release-barrier/**",
  "scripts/release-phases/**",
  "scripts/release-merge/**",
  "scripts/deploy-safety/**",
  "scripts/deploy-main/**",
  "scripts/deploy.ts",
  ".github/workflows/deploy.yml",
  ".github/workflows/release-main.yml",
  ".github/workflows/release-manual.yml",
  ".github/workflows/release-rollback.yml",
  ".github/workflows/pool-runtime-provision.yml",
];

test("release path covers release code, workflows and Alchemy carries but not product code", () => {
  assert.equal(onReleasePath("scripts/release-barrier/runtime-image-release.ts"), true);
  assert.equal(onReleasePath("scripts/release/deploy.ts"), true);
  assert.equal(onReleasePath("patches/0370-alchemy-worker-upload-hook.patch"), true);
  assert.equal(onReleasePath(".github/workflows/release.yml"), true);
  assert.equal(onReleasePath("alchemy.run.ts"), true);
  assert.equal(onReleasePath("src/pool/worker.ts"), false);
  assert.equal(onReleasePath("patches/0006-product-brand.patch"), false);
  assert.equal(onReleasePath("scripts/releases/patches.json"), false);
});

test(
  "the 16 Nov candidate replaced the release path of the last good release",
  needsHistory,
  () => {
    assert.notEqual(
      releasePathHash(root, "dae3b327", measured),
      releasePathHash(root, "0ae42a54", measured),
    );
    assert.deepEqual(releasePathChange(root, "0ae42a54", "dae3b327", measured), {
      files: 127,
      added: 9597,
      removed: 681,
    });
    // By the 18 Nov candidate it had grown by another 18,500 lines while every release failed.
    assert.deepEqual(releasePathChange(root, "0ae42a54", "5c68c6ab", measured), {
      files: 275,
      added: 28397,
      removed: 1693,
    });
  },
);

test(
  "the 6 Nov failure that started the first spiral also changed the release path",
  needsHistory,
  () => {
    assert.deepEqual(releasePathChange(root, "a637b6de", "a67568a6", measured), {
      files: 5,
      added: 174,
      removed: 34,
    });
  },
);

test("the hash depends only on release-path files", needsHistory, () => {
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
