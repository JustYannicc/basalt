import assert from "node:assert/strict";
import { test } from "node:test";
import { validateChangedFiles, validatePreviewReceipt, validatePullRequestIdentity, type ChangedFile, type FileContents, type ReleasePins } from "./policy.ts";

const basePins: ReleasePins = {
  tools: { repository: "UsefulSoftwareCo/executor", commit: "1".repeat(40) },
  home: artifact("CLIProxyAPIHome", "2"),
  node: artifact("CLIProxyAPI", "3"),
};
const candidatePins: ReleasePins = {
  ...basePins,
  tools: { repository: basePins.tools.repository, commit: "4".repeat(40) },
};
const baseUpstream = JSON.stringify({ repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: basePins.tools.commit });
const candidateUpstream = JSON.stringify({ repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: candidatePins.tools.commit });
const poolText = JSON.stringify({ format_version: 1, artifacts: { home: basePins.home, node: basePins.node } });
const candidatePoolText = JSON.stringify({ format_version: 1, artifacts: { home: artifact("CLIProxyAPIHome", "5"), node: basePins.node } });

function artifact(binary: string, commitStart: string) {
  return {
    repository: "UsefulSoftwareCo/CLIProxyAPI",
    tag: "v1.2.3",
    commit: commitStart.repeat(40),
    binary,
    assets: {
      amd64: { name: `${binary}_linux_amd64.tar.gz`, sha256: "a".repeat(64) },
      arm64: { name: `${binary}_linux_arm64.tar.gz`, sha256: "b".repeat(64) },
    },
  };
}

function releaseReceipt(source: "tools" | "home" | "node", base: ReleasePins, candidate: ReleasePins, removedPatches: string[] = []) {
  const normalizeReceiptPins = (pins: ReleasePins) => ({
    ...pins,
    tools: { ...pins.tools, repository: `https://github.com/${pins.tools.repository}.git` },
  });
  return JSON.stringify({
    schemaVersion: 1,
    source,
    releaseKey: `${source}-v1.2.3`,
    basePins: normalizeReceiptPins(base),
    candidatePins: normalizeReceiptPins(candidate),
    removedPatches,
  });
}

function file(filename: string, status: ChangedFile["status"] = "modified", additions = 1, deletions = 1): ChangedFile {
  return { filename, status, additions, deletions, changes: additions + deletions };
}

function toolsPinCandidate(): { files: ChangedFile[]; contents: FileContents } {
  return {
    files: [file("upstream.json"), file("scripts/releases/receipts/tools.json", "added", 1, 0)],
    contents: {
      "upstream.json": { base: baseUpstream, candidate: candidateUpstream },
      "containers/pool/releases.json": { base: poolText, candidate: poolText },
      "scripts/releases/receipts/tools.json": { candidate: releaseReceipt("tools", basePins, candidatePins) },
    },
  };
}

const pr = (changes: Partial<Parameters<typeof validatePullRequestIdentity>[0]> = {}) => ({
  number: 19,
  state: "open",
  head: { sha: "f".repeat(40), ref: "release-updates/tools-1.2.3", repo: { full_name: "owner/repo" } },
  base: { ref: "main", sha: "e".repeat(40), repo: { full_name: "owner/repo" } },
  labels: [{ name: "release-update" }],
  ...changes,
});

test("accepts one tools pin update whose receipt matches the exact pin snapshots", () => {
  const candidate = toolsPinCandidate();
  assert.deepEqual(validateChangedFiles(candidate.files, candidate.contents), {
    allowed: true,
    reasons: [],
    source: "tools",
    releaseKey: "tools-v1.2.3",
    removedPatches: [],
  });
});

test("accepts removal-only carried patch and matching logical manifest removal", () => {
  const manifest = {
    format_version: 1,
    repository: "UsefulSoftwareCo/executor",
    patches: [
      { file: "0001.patch", upstream_pull_request: 2348, database_sensitive: false, workflow_sensitive: false },
      { file: "0002.patch", upstream_pull_request: null, database_sensitive: false, workflow_sensitive: false },
    ],
  };
  const remaining = { ...manifest, patches: manifest.patches.slice(1) };
  const files = [file("patches/0001.patch", "removed", 0, 20), file("scripts/releases/patches.json") , file("scripts/releases/receipts/tools.json", "added", 1, 0)];
  const contents: FileContents = {
    "upstream.json": { base: baseUpstream, candidate: baseUpstream },
    "containers/pool/releases.json": { base: poolText, candidate: poolText },
    "scripts/releases/patches.json": { base: JSON.stringify(manifest), candidate: JSON.stringify(remaining) },
    "scripts/releases/receipts/tools.json": { candidate: releaseReceipt("tools", basePins, basePins, ["0001.patch"]) },
  };
  assert.equal(validateChangedFiles(files, contents).allowed, true);
});

test("accepts generated provider data only alongside a home pin update", () => {
  const baseHome = basePins.home;
  const nextHome = artifact("CLIProxyAPIHome", "5");
  const nextPins = { ...basePins, home: nextHome };
  const files = [file("containers/pool/releases.json"), file("src/pool/providers.json"), file("scripts/releases/receipts/home.json", "added", 1, 0)];
  const contents: FileContents = {
    "upstream.json": { base: baseUpstream, candidate: baseUpstream },
    "containers/pool/releases.json": { base: poolText, candidate: candidatePoolText },
    "src/pool/providers.json": { base: "[]", candidate: JSON.stringify([{ id: "alpha", name: "Alpha" }]) },
    "scripts/releases/receipts/home.json": { candidate: releaseReceipt("home", basePins, nextPins) },
  };
  assert.equal(validateChangedFiles(files, contents).allowed, true);
  assert.equal(validateChangedFiles(files.slice(1), contents).allowed, false);
  assert.equal(validateChangedFiles([files[0]!, files[2]!], contents).allowed, true);
});

test("accepts an independent node pin update with its matching receipt", () => {
  const node = artifact("CLIProxyAPI", "6");
  const candidatePinsForNode = { ...basePins, node };
  const nextPool = JSON.stringify({ format_version: 1, artifacts: { home: basePins.home, node } });
  const files = [file("containers/pool/releases.json"), file("scripts/releases/receipts/node.json", "added", 1, 0)];
  const contents: FileContents = {
    "upstream.json": { base: baseUpstream, candidate: baseUpstream },
    "containers/pool/releases.json": { base: poolText, candidate: nextPool },
    "scripts/releases/receipts/node.json": { candidate: releaseReceipt("node", basePins, candidatePinsForNode) },
  };
  assert.equal(validateChangedFiles(files, contents).allowed, true);
  const combined = JSON.parse(nextPool) as { format_version: number; artifacts: Record<string, unknown> };
  combined.artifacts.home = artifact("CLIProxyAPIHome", "7");
  contents["containers/pool/releases.json"]!.candidate = JSON.stringify(combined);
  assert.equal(validateChangedFiles(files, contents).allowed, false);
});

test("rejects modified patches, forged workflows, and provider table edits without a home pin", () => {
  const tools = toolsPinCandidate();
  assert.equal(validateChangedFiles([file("patches/0001.patch")], tools.contents).allowed, false);
  assert.equal(validateChangedFiles([...tools.files, file(".github/workflows/release-preview.yml")], tools.contents).allowed, false);

  const tableFiles = [file("src/pool/providers.json"), ...tools.files];
  const tableContents = { ...tools.contents, "src/pool/providers.json": { candidate: '[{"id":"alpha","name":"Alpha"}]' } };
  assert.equal(validateChangedFiles(tableFiles, tableContents).allowed, false);
});

test("rejects changed manifest records and receipts that claim unrelated pins", () => {
  const manifest = {
    format_version: 1,
    repository: "UsefulSoftwareCo/executor",
    patches: [{ file: "0001.patch", upstream_pull_request: null, database_sensitive: false, workflow_sensitive: false }],
  };
  const edited = { ...manifest, patches: [{ ...manifest.patches[0], database_sensitive: true }] };
  const files = [file("scripts/releases/patches.json"), ...toolsPinCandidate().files];
  const contents = { ...toolsPinCandidate().contents, "scripts/releases/patches.json": { base: JSON.stringify(manifest), candidate: JSON.stringify(edited) } };
  assert.equal(validateChangedFiles(files, contents).allowed, false);

  const candidate = toolsPinCandidate();
  candidate.contents["scripts/releases/receipts/tools.json"] = { candidate: releaseReceipt("tools", basePins, { ...candidatePins, home: artifact("CLIProxyAPIHome", "7") }) };
  assert.equal(validateChangedFiles(candidate.files, candidate.contents).allowed, false);
});

test("validates current repository, branch, label, base and exact head", () => {
  const valid = pr();
  assert.deepEqual(validatePullRequestIdentity(valid, "owner/repo", "e".repeat(40), "f".repeat(40)), []);
  assert.match(validatePullRequestIdentity(pr({ head: { ...valid.head, ref: "release-updates-evil" } }), "owner/repo", "e".repeat(40))[0]!, /updater branch/);
  assert.match(validatePullRequestIdentity(pr({ labels: [] }), "owner/repo", "e".repeat(40))[0]!, /label/);
  assert.match(validatePullRequestIdentity(pr({ base: { ...valid.base, sha: "d".repeat(40) } }), "owner/repo", "e".repeat(40))[0]!, /stale/);
  assert.match(validatePullRequestIdentity(pr({ head: { ...valid.head, repo: { full_name: "fork/repo" } } }), "owner/repo", "e".repeat(40))[0]!, /current repository/);
});

test("preview receipt binds the PR, head, current main, smoke and teardown", () => {
  const receipt = { version: 1, pullRequest: 19, head: "f".repeat(40), base: "e".repeat(40), smoke: true, teardown: true };
  assert.deepEqual(validatePreviewReceipt(receipt, { pullRequest: 19, head: "f".repeat(40), base: "e".repeat(40) }), []);
  assert.match(validatePreviewReceipt({ ...receipt, head: "d".repeat(40) }, { pullRequest: 19, head: "f".repeat(40), base: "e".repeat(40) }).join(" "), /head/);
  assert.match(validatePreviewReceipt({ ...receipt, base: "d".repeat(40) }, { pullRequest: 19, head: "f".repeat(40), base: "e".repeat(40) }).join(" "), /base/);
  assert.match(validatePreviewReceipt({ ...receipt, teardown: false }, { pullRequest: 19, head: "f".repeat(40), base: "e".repeat(40) }).join(" "), /teardown/);
  assert.match(validatePreviewReceipt({ ...receipt, secret: "no" }, { pullRequest: 19, head: "f".repeat(40), base: "e".repeat(40) }).join(" "), /unexpected/);
});
