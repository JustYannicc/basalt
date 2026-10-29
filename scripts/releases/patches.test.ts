import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPatchManifestContentMatchesFiles,
  assertPatchManifestMatchesFiles,
  assertPoolCarryManifestContent,
  parsePatchManifest,
  parsePatchManifestV3,
  patchMappingKey,
  removedPatchRecords,
  sha256PatchContent,
  updatedManifest,
} from "./patch-registry.ts";
import { decidePatchRemovals, readPatchManifest } from "./patches.ts";
import { patchFixtureContent, patchManifest, sha } from "./fixtures.test-helpers.ts";

test("the checked-in registry matches every carried patch's exact bytes", () => {
  readPatchManifest(fileURLToPath(new URL("../../", import.meta.url)));
});

test("format 3 registry requires unique semantic identities, locators, and content digests", () => {
  assert.deepEqual(parsePatchManifestV3(JSON.stringify(patchManifest)), patchManifest);
  assert.throws(() => parsePatchManifest(JSON.stringify({ ...patchManifest, extra: true })), /Invalid/);
  assert.throws(() => parsePatchManifest(JSON.stringify({
    ...patchManifest,
    patches: [{ ...patchManifest.patches[0], identity: undefined }],
  })), /Invalid or duplicate/);
  assert.throws(() => parsePatchManifest(JSON.stringify({
    ...patchManifest,
    patches: [patchManifest.patches[0], { ...patchManifest.patches[1], identity: patchManifest.patches[0]!.identity }],
  })), /Invalid or duplicate/);
  assert.throws(() => parsePatchManifest(JSON.stringify({
    ...patchManifest,
    patches: [patchManifest.patches[0], { ...patchManifest.patches[1], content_sha256: patchManifest.patches[0]!.content_sha256 }],
  })), /Invalid or duplicate/);
});

test("pool carry bindings are explicit and cannot be changed by automated tools-patch retirement", () => {
  const pool_carries = { manifest: "containers/pool/sources.json", content_sha256: "a".repeat(64) };
  assert.deepEqual(parsePatchManifestV3(JSON.stringify({ ...patchManifest, pool_carries })).pool_carries, pool_carries);
  assert.throws(() => assertPoolCarryManifestContent({ ...patchManifest, pool_carries: { ...pool_carries, manifest: "containers/pool/sources.json" } }, Buffer.from("different bytes")), /digest does not match/);
  assert.throws(() => parsePatchManifestV3(JSON.stringify({ ...patchManifest, pool_carries: { ...pool_carries, manifest: "elsewhere.json" } })), /Invalid pool/);
  const result = removedPatchRecords({ base: JSON.stringify({ ...patchManifest, pool_carries }),
    candidate: JSON.stringify({ ...patchManifest, patches: [] }) });
  assert.equal(result.ok, false);
});

test("strict JSON rejects duplicate keys, including nested patch fields", () => {
  const source = JSON.stringify(patchManifest).replace(
    '"content_sha256":',
    '"content_sha256": "0000000000000000000000000000000000000000000000000000000000000000", "content_sha256":',
  );
  assert.throws(() => parsePatchManifest(source), /Duplicate JSON object key/);
});

test("patch hashes bind exact bytes and do not follow a reused locator", () => {
  const patch = patchManifest.patches[0]!;
  assert.throws(() => assertPatchManifestContentMatchesFiles(patchManifest, {
    [patch.file]: Buffer.from("different patch bytes\n"),
    [patchManifest.patches[1]!.file]: Buffer.from(patchFixtureContent(patchManifest.patches[1]!.file)),
  }), /digest does not match/);
  assert.equal(sha256PatchContent(Buffer.from(patchFixtureContent(patch.file))), patch.content_sha256);
});

test("renumbering the same bytes preserves identity and upstream mapping", () => {
  const renamed = {
    ...patchManifest,
    patches: patchManifest.patches.map((patch) => patch.identity === "executor-review"
      ? { ...patch, file: "0013-review.patch" }
      : patch),
  };
  const parsed = parsePatchManifestV3(JSON.stringify(renamed));
  assertPatchManifestMatchesFiles(parsed, ["0013-review.patch", "0004-workflow.patch"]);
  assertPatchManifestContentMatchesFiles(parsed, {
    "0013-review.patch": Buffer.from(patchFixtureContent("0001-review.patch")),
    "0004-workflow.patch": Buffer.from(patchFixtureContent("0004-workflow.patch")),
  });
  const record = parsed.patches.find(({ identity }) => identity === "executor-review");
  assert.equal(record?.upstream_pull_request, 10);
  assert.equal(record?.content_sha256, patchManifest.patches[0]?.content_sha256);
});

test("removed records and overlays keep stable identity references", async () => {
  const frameworkContent = "overlay framework bytes\n";
  const manifest = parsePatchManifestV3(JSON.stringify({
    ...patchManifest,
    patches: [
      ...patchManifest.patches,
      {
        identity: "basalt-framework",
        file: "0009-framework.patch",
        content_sha256: sha256PatchContent(frameworkContent),
        kind: "overlay",
        upstream_pull_request: null,
        database_sensitive: false,
        workflow_sensitive: false,
        remove_with: "executor-review",
        requires: "manual framework retirement",
      },
    ],
  }));
  const updated = updatedManifest(manifest, new Set(["executor-review"]));
  assert.equal(updated.patches.some(({ identity }) => identity === "executor-review"), false);
  const framework = updated.patches.find(({ identity }) => identity === "basalt-framework");
  assert.ok(framework?.kind === "overlay");
  assert.equal(framework.remove_with, "executor-review");

  const removals = removedPatchRecords({
    base: JSON.stringify(manifest),
    candidate: JSON.stringify(updated),
  });
  assert.equal(removals.ok, true, "retiring an upstream patch keeps its overlay dependency");
  if (removals.ok) assert.deepEqual(removals.removed, [{
    identity: "executor-review",
    file: "0001-review.patch",
    content_sha256: patchManifest.patches[0]?.content_sha256,
    kind: "upstream",
  }]);

  const decision = await decidePatchRemovals(
    manifest,
    manifest.patches.map(({ file }) => file),
    sha("e"),
    {
      async get() { return { merged: true, merge_commit_sha: sha("f") }; },
      async compare() { return { complete: true, status: "ahead", aheadBy: 1, behindBy: 0, files: [] }; },
    } as never,
  );
  assert.deepEqual(decision.find(({ identity }) => identity === "executor-review"), {
    identity: "executor-review",
    file: "0001-review.patch",
    content_sha256: patchManifest.patches[0]?.content_sha256,
    remove: true,
    reason: "merged-commit-in-candidate",
  });
  assert.equal(decision.find(({ identity }) => identity === "basalt-framework")?.remove, false);
  assert.equal(updated.patches.some(({ identity }) => identity === "basalt-framework"), true);
});

test("a tools update cannot replace a patch identity while reusing its locator and bytes", () => {
  const base = patchManifest.patches[0]!;
  const candidate = {
    ...patchManifest,
    patches: [
      { ...base, identity: "replacement-review" },
      ...patchManifest.patches.slice(1),
    ],
  };
  const result = removedPatchRecords({
    base: JSON.stringify(patchManifest),
    candidate: JSON.stringify(candidate),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /records may only be removed/);
});

test("format 2 remains parseable for historical readers but cannot pass the format 3 parser", () => {
  const legacy = {
    format_version: 2,
    repository: "UsefulSoftwareCo/executor",
    patches: [{
      file: "0001-review.patch",
      kind: "upstream",
      upstream_pull_request: 10,
      database_sensitive: false,
      workflow_sensitive: false,
    }],
  };
  assert.equal(parsePatchManifest(JSON.stringify(legacy)).format_version, 2);
  assert.throws(() => parsePatchManifestV3(JSON.stringify(legacy)), /Format 3/);
});


test("an upstream issue tracks provenance without allowing automatic patch retirement", async () => {
  const issueTracked = {
    ...patchManifest.patches[0]!,
    kind: "upstream",
    upstream_pull_request: null,
    upstream_issue: 2364,
  };
  const manifest = parsePatchManifestV3(JSON.stringify({ ...patchManifest, patches: [issueTracked] }));
  assert.equal(manifest.patches[0]?.upstream_issue, 2364);
  assert.notEqual(patchMappingKey(manifest.repository, manifest.patches[0]!),
    patchMappingKey(manifest.repository, { ...manifest.patches[0]!, upstream_issue: 2375 }));
  const decisions = await decidePatchRemovals(manifest, [issueTracked.file], sha("e"), {
    async get() { assert.fail("an issue is not a pull request and cannot authorize retirement"); },
    async compare() { assert.fail("an issue has no merge commit to compare"); },
  });
  assert.equal(decisions[0]?.remove, false);
  assert.equal(decisions[0]?.reason, "no-upstream-pull-request");
});

test("upstream issue provenance must be a positive integer", () => {
  for (const issue of [0, -1, 1.5, "2364", null]) {
    assert.throws(() => parsePatchManifestV3(JSON.stringify({
      ...patchManifest,
      patches: [{ ...patchManifest.patches[0], upstream_issue: issue }],
    })), /Invalid/);
  }
});
