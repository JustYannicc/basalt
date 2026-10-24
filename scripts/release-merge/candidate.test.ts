import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseCandidate, type CandidateApi } from "./candidate.ts";
import { RELEASE_MERGE_POLICY, type ChangedFile, type PullRequestSnapshot, type ReleasePins } from "./policy.ts";
import { sha256PatchContent } from "../releases/patch-registry.ts";
import type { PatchManifestV3 } from "../releases/types.ts";

const main = "e".repeat(40);
const head = "f".repeat(40);
const basePins: ReleasePins = {
  tools: { repository: "UsefulSoftwareCo/executor", commit: "1".repeat(40) },
  home: artifact("CLIProxyAPIHome", "2"),
  node: artifact("CLIProxyAPI", "3"),
};
const upstreamText = JSON.stringify({
  repository: "https://github.com/UsefulSoftwareCo/executor.git",
  commit: basePins.tools.commit,
});
const poolText = JSON.stringify({
  format_version: 1,
  artifacts: { home: basePins.home, node: basePins.node },
});
const patchContent = "diff --git a/packages/review.ts b/packages/review.ts\n+export const reviewed = true;\n";
const patchDigest = sha256PatchContent(patchContent);
const baseManifest: PatchManifestV3 = {
  format_version: 3,
  repository: "UsefulSoftwareCo/executor",
  patches: [{
    identity: "executor-reviewed-change",
    file: "0001-reviewed.patch",
    content_sha256: patchDigest,
    kind: "upstream",
    upstream_pull_request: 2348,
    database_sensitive: false,
    workflow_sensitive: false,
  }],
};
const candidateManifest: PatchManifestV3 = {
  ...baseManifest,
  patches: [],
};
const receipt = JSON.stringify({
  schemaVersion: 2,
  source: "tools",
  releaseKey: "tools-v1.2.3",
  basePins,
  candidatePins: basePins,
  removedPatches: [{ identity: "executor-reviewed-change", content_sha256: patchDigest }],
});
const files: ChangedFile[] = [
  { filename: "patches/0001-reviewed.patch", status: "removed", additions: 0, deletions: 2, changes: 2 },
  { filename: "scripts/releases/patches.json", status: "modified", additions: 1, deletions: 1, changes: 2 },
  { filename: "scripts/releases/receipts/tools.json", status: "added", additions: 1, deletions: 0, changes: 1 },
];

test("candidate validation fetches the removed base blob and binds receipt identity to its bytes", async () => {
  const reads: string[] = [];
  const api = candidateApi(async (path, ref) => {
    reads.push(`${ref}:${path}`);
    if (path === "upstream.json") return upstreamText;
    if (path === "containers/pool/releases.json") return poolText;
    if (path === RELEASE_MERGE_POLICY.patchManifestPath) return JSON.stringify(ref === main ? baseManifest : candidateManifest);
    if (path === RELEASE_MERGE_POLICY.releaseReceiptPrefix + "tools.json" && ref === head) return receipt;
    if (path === "patches/0001-reviewed.patch" && ref === main) return patchContent;
    return undefined;
  });

  const result = await validateReleaseCandidate(api, "owner/repo", 19, head);
  assert.equal(result.allowed, true, result.reasons.join("; "));
  assert.deepEqual(result.removedPatches, [{
    identity: "executor-reviewed-change",
    content_sha256: patchDigest,
  }]);
  assert.ok(reads.includes(`${main}:patches/0001-reviewed.patch`));
  assert.ok(reads.includes(`${head}:patches/0001-reviewed.patch`));
});

test("candidate validation rejects a receipt whose base patch bytes do not match the registry", async () => {
  const api = candidateApi(async (path, ref) => {
    if (path === "upstream.json") return upstreamText;
    if (path === "containers/pool/releases.json") return poolText;
    if (path === RELEASE_MERGE_POLICY.patchManifestPath) return JSON.stringify(ref === main ? baseManifest : candidateManifest);
    if (path === RELEASE_MERGE_POLICY.releaseReceiptPrefix + "tools.json" && ref === head) return receipt;
    if (path === "patches/0001-reviewed.patch" && ref === main) return "different bytes under the same locator\n";
    return undefined;
  });

  const result = await validateReleaseCandidate(api, "owner/repo", 19, head);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /content digest does not match/);
});

function candidateApi(lookup: (path: string, ref: string) => Promise<string | undefined>): CandidateApi {
  const pullRequest: PullRequestSnapshot = {
    number: 19,
    state: "open",
    head: { sha: head, ref: "release-updates/tools-v1.2.3", repo: { full_name: "owner/repo" } },
    base: { ref: "main", sha: main, repo: { full_name: "owner/repo" } },
    labels: [{ name: "release-update" }],
  };
  return {
    async getPullRequest() { return pullRequest; },
    async getBranchSha() { return main; },
    async compareAncestry() { return { status: "ahead", mergeBaseSha: main }; },
    async listPullRequestFiles() { return files; },
    async getFileAt(_repository, path, ref) { return lookup(path, ref); },
  };
}

function artifact(binary: string, digit: string) {
  return {
    repository: "router-for-me/CLIProxyAPI",
    tag: "v1.2.3",
    commit: digit.repeat(40),
    binary,
    assets: {
      amd64: { name: `${binary}_linux_amd64.tar.gz`, sha256: "a".repeat(64) },
      arm64: { name: `${binary}_linux_arm64.tar.gz`, sha256: "b".repeat(64) },
    },
  };
}
