import assert from "node:assert/strict";
import test from "node:test";
import { decidePatchRemovals, parsePatchManifest } from "./patches.ts";
import { sha } from "./fixtures.test-helpers.ts";

const base = {
  format_version: 2,
  repository: "UsefulSoftwareCo/executor",
  patches: [
    { file: "0008-caller-identity.patch", kind: "upstream", upstream_pull_request: 2346, database_sensitive: false, workflow_sensitive: true },
    { file: "0009-basalt-framework.patch", kind: "overlay", upstream_pull_request: null, database_sensitive: false, workflow_sensitive: false, remove_with: "0008-caller-identity.patch", requires: "npm apps release with executor#2346" },
    { file: "0010-member-pools.patch", kind: "overlay", upstream_pull_request: null, database_sensitive: true, workflow_sensitive: false, upstream_issue: 2362 },
    { file: "0003-eu-durable-objects.patch", kind: "upstream", upstream_pull_request: null, database_sensitive: false, workflow_sensitive: true },
  ],
};

test("v2 patch manifest parser rejects unknown top-level and patch fields", () => {
  assert.deepEqual(parsePatchManifest(JSON.stringify(base)), base);
  assert.throws(() => parsePatchManifest(JSON.stringify({ ...base, extra: true })), /Invalid scripts\/releases\/patches.json/);
  assert.throws(() => parsePatchManifest(JSON.stringify({
    ...base,
    patches: [{ ...base.patches[0], unsafe: true }],
  })), /Invalid or duplicate carried patch record/);
});

test("patch kinds constrain provenance and overlay retirement metadata", () => {
  for (const patch of [
    { ...base.patches[1], upstream_pull_request: 2346 },
    { ...base.patches[1], requires: undefined },
    { ...base.patches[0], kind: "other" },
  ]) {
    assert.throws(() => parsePatchManifest(JSON.stringify({ ...base, patches: [patch] })), /Invalid or duplicate carried patch record/);
  }
});

test("overlay patches stay carried even when their referenced upstream patch drops", async () => {
  const manifest = parsePatchManifest(JSON.stringify(base));
  const decisions = await decidePatchRemovals(
    manifest,
    manifest.patches.map(({ file }) => file),
    sha("e"),
    {
      async get() { return { merged: true, merge_commit_sha: sha("f") }; },
      async compare() { return { complete: true, status: "ahead", aheadBy: 1, behindBy: 0, files: [] }; },
    } as never,
  );

  assert.equal(decisions.find(({ file }) => file === "0008-caller-identity.patch")?.remove, true);
  assert.deepEqual(decisions.find(({ file }) => file === "0009-basalt-framework.patch"), {
    file: "0009-basalt-framework.patch", remove: false, reason: "overlay-retirement-proof-unavailable",
  });
  assert.deepEqual(decisions.find(({ file }) => file === "0010-member-pools.patch"), {
    file: "0010-member-pools.patch", remove: false, reason: "overlay-does-not-auto-retire",
  });
  assert.deepEqual(decisions.find(({ file }) => file === "0003-eu-durable-objects.patch"), {
    file: "0003-eu-durable-objects.patch", remove: false, reason: "no-upstream-pull-request",
  });
});
