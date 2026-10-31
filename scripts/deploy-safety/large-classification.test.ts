import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { classifyRefs } from "../releases/classify.ts";
import { makeReleaseRoot } from "../releases/fixtures.test-helpers.ts";
import { sha256PatchContent } from "../releases/patch-registry.ts";
import type { PatchManifestV3 } from "../releases/types.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(root: string): string {
  git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
}

function replacePatch(root: string, content: string | Buffer): void {
  const path = join(root, "scripts/releases/patches.json");
  const manifest: PatchManifestV3 = JSON.parse(readFileSync(path, "utf8"));
  const patch = manifest.patches[0]!;
  patch.content_sha256 = sha256PatchContent(content);
  writeFileSync(join(root, "patches", patch.file), content);
  writeFileSync(path, JSON.stringify(manifest));
}

test("release classification reads large patch blobs completely and verifies their digests", async () => {
  const root = makeReleaseRoot();
  try {
    git(root, "init", "--quiet");
    const base = commit(root);
    const padding = "+generated renderer bytes\n".repeat(100_000);
    assert.ok(Buffer.byteLength(padding) > 1024 * 1024);
    replacePatch(root, padding + "+CREATE TABLE release_fixture (id integer);\n+workflowStep.task('fixture');\n");
    const candidate = commit(root);
    const report = await classifyRefs(root, base, candidate);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.base.gitCommit, base);
    assert.equal(report.candidate.gitCommit, candidate);
    assert.equal(report.databaseChanged, true);
    assert.equal(report.workflowChanged, true);
    assert.equal(report.evidence.database.state, "changed");
    assert.equal(report.evidence.workflow.state, "changed");

    writeFileSync(join(root, "README.md"), "docs only\n");
    const docs = commit(root);
    const unchanged = await classifyRefs(root, candidate, docs);
    assert.equal(unchanged.databaseChanged, false);
    assert.equal(unchanged.workflowChanged, false);

    writeFileSync(join(root, "patches/0001-review.patch"), padding + "tampered\n");
    await assert.rejects(classifyRefs(root, docs, commit(root)), /Patch content digest does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release classification fails closed when a patch exceeds the Git output bound", async () => {
  const root = makeReleaseRoot();
  try {
    git(root, "init", "--quiet");
    const base = commit(root);
    replacePatch(root, Buffer.alloc(65 * 1024 * 1024, "+"));
    await assert.rejects(classifyRefs(root, base, commit(root)), { code: "ENOBUFS" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
