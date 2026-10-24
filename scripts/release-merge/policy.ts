import {
  readReleasePins,
  sameJson,
  validatePoolPins,
  validateUpstreamPins,
  validProviderTable,
} from "./metadata.ts";
import { removedPatchRecords, sha256PatchContent, type PatchManifestRemoval } from "../releases/patch-registry.ts";
import { samePatchRemovalReceipts, validateReleaseReceipt } from "../releases/receipts.ts";
import type { PatchRemovalReceipt } from "../releases/types.ts";

export type { ReleasePins } from "./metadata.ts";

export const RELEASE_MERGE_POLICY = Object.freeze({
  baseBranch: "main",
  updaterBranchPrefix: "release-updates/",
  releaseLabel: "release-update",
  workflows: Object.freeze({ ci: "Check", preview: "Release preview" }),
  upstreamPinsPath: "upstream.json",
  poolPinsPath: "containers/pool/releases.json",
  providerTablePath: "src/pool/providers.json",
  patchManifestPath: "scripts/releases/patches.json",
  releaseReceiptPrefix: "scripts/releases/receipts/",
  generatedArchitecturePath: "architecture/gen/stack.gen.c4",
  previewReceiptFile: "preview-receipt.json",
  checkReceiptFile: "check-receipt.json",
  checkArtifactName(prNumber: number, head: string, runAttempt: number) {
    return `release-check-${prNumber}-${head}-${runAttempt}`;
  },
  previewArtifactName(prNumber: number, head: string) {
    return `release-preview-${prNumber}-${head}`;
  },
});

export type CheckRunReceipt = Readonly<{
  version: 1;
  repository: string;
  pullRequest: number;
  runId: number;
  runAttempt: number;
  head: string;
  base: string;
  mergeCommit: string;
  parents: readonly [base: string, head: string];
}>;

export type PullRequestSnapshot = {
  number: number;
  state: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
};

export type ChangedFile = {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | string;
  additions: number;
  deletions: number;
  changes: number;
};

export type FileContents = Record<string, { base?: string; candidate?: string }>;

export type CandidatePolicyResult = {
  allowed: boolean;
  reasons: string[];
  source?: "tools" | "home" | "node";
  releaseKey?: string;
  removedPatches?: PatchRemovalReceipt[];
};

const SHA = /^[a-f0-9]{40}$/i;
const PATCH_FILE = /^patches\/([A-Za-z0-9][A-Za-z0-9._-]*\.patch)$/;
const RELEASE_RECEIPT = /^scripts\/releases\/receipts\/(tools|home|node)\.json$/;

export function validatePullRequestIdentity(
  pr: PullRequestSnapshot,
  repository: string,
  currentMainSha: string,
  expectedHeadSha?: string,
  options: { allowStaleBase?: boolean } = {},
): string[] {
  const reasons: string[] = [];
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) reasons.push("invalid pull request number");
  if (pr.state !== "open") reasons.push("pull request is not open");
  if (pr.head.repo?.full_name !== repository || pr.base.repo?.full_name !== repository)
    reasons.push("pull request is not from the current repository");
  if (pr.base.ref !== RELEASE_MERGE_POLICY.baseBranch) reasons.push("base branch is not main");
  if (!SHA.test(pr.base.sha)) reasons.push("pull request base SHA is invalid");
  else if (pr.base.sha !== currentMainSha && options.allowStaleBase !== true) reasons.push("pull request base is stale");
  if (!pr.head.ref.startsWith(RELEASE_MERGE_POLICY.updaterBranchPrefix)) reasons.push("head branch is not an updater branch");
  if (!pr.labels.some(({ name }) => name === RELEASE_MERGE_POLICY.releaseLabel)) reasons.push("release-update label is missing");
  if (!SHA.test(pr.head.sha)) reasons.push("head SHA is invalid");
  if (!SHA.test(currentMainSha)) reasons.push("main SHA is invalid");
  if (expectedHeadSha !== undefined && pr.head.sha !== expectedHeadSha) reasons.push("pull request head changed");
  return reasons;
}

export function validateChangedFiles(files: ChangedFile[], contents: FileContents): CandidatePolicyResult {
  const reasons: string[] = [];
  const names = files.map(({ filename }) => filename);
  if (files.length === 0) reasons.push("pull request has no changed files");
  if (new Set(names).size !== names.length) reasons.push("changed-file list contains duplicates");
  if (names.some((name) => !safeRepoPath(name))) reasons.push("changed-file list contains an unsafe path");

  const byName = new Map(files.map((file) => [file.filename, file]));
  const patchRemovals: string[] = [];
  let changedUpstream = false;
  let changedPool = false;
  let homeChanged = false;
  let nodeChanged = false;
  let toolsChanged = false;
  let manifestRemoved: PatchManifestRemoval[] = [];
  const receiptFiles: Array<{ source: "tools" | "home" | "node"; path: string }> = [];

  for (const file of files) {
    const { filename } = file;
    if (filename === RELEASE_MERGE_POLICY.upstreamPinsPath) {
      changedUpstream = true;
      if (file.status !== "modified") reasons.push("upstream pin file must be modified in place");
      const change = validateUpstreamPins(contents[filename]);
      if (!change.ok) reasons.push(`${filename}: ${change.reason}`);
      toolsChanged = change.changed;
      continue;
    }
    if (filename === RELEASE_MERGE_POLICY.poolPinsPath) {
      changedPool = true;
      if (file.status !== "modified") reasons.push("pool pin file must be modified in place");
      const change = validatePoolPins(contents[filename]);
      if (!change.ok) reasons.push(`${filename}: ${change.reason}`);
      homeChanged = change.homeChanged;
      nodeChanged = change.nodeChanged;
      continue;
    }
    if (filename === RELEASE_MERGE_POLICY.providerTablePath) {
      if (file.status !== "modified") reasons.push("provider table must be modified in place");
      if (!contents[filename]?.candidate || !validProviderTable(contents[filename]?.candidate))
        reasons.push("provider table is invalid JSON or has invalid rows");
      continue;
    }
    if (filename === RELEASE_MERGE_POLICY.patchManifestPath) {
      if (file.status !== "modified") reasons.push("patch manifest must be modified in place");
      const change = removedPatchRecords(contents[filename]);
      if (!change.ok) reasons.push(`${filename}: ${change.reason}`);
      else manifestRemoved = change.removed;
      continue;
    }
    if (filename === RELEASE_MERGE_POLICY.generatedArchitecturePath) {
      if (file.status !== "modified") reasons.push("generated architecture file must be modified in place");
      continue;
    }
    const patch = PATCH_FILE.exec(filename);
    if (patch) {
      if (file.status !== "removed" || file.additions !== 0 || file.deletions <= 0 || file.changes !== file.deletions)
        reasons.push(`${filename}: carried patches may only be removed`);
      else patchRemovals.push(patch[1]!);
      continue;
    }
    const receipt = RELEASE_RECEIPT.exec(filename);
    if (receipt) {
      if (file.status !== "added" && file.status !== "modified") reasons.push(`${filename}: release receipt may only be added or modified`);
      receiptFiles.push({ source: receipt[1] as "tools" | "home" | "node", path: filename });
      continue;
    }
    reasons.push(`${filename}: file is outside the release updater allowlist`);
  }

  if (receiptFiles.length !== 1) reasons.push("exactly one source receipt is required");
  if (new Set(patchRemovals).size !== patchRemovals.length) reasons.push("patch removal list contains duplicates");
  if (!sameStringSet(patchRemovals, manifestRemoved.map(({ file }) => file)))
    reasons.push("patch file and tracking manifest removals differ");
  for (const patch of manifestRemoved) {
    const content = contents[`patches/${patch.file}`]?.base;
    if (content === undefined) reasons.push(`patches/${patch.file}: base patch content is missing`);
    else if (sha256PatchContent(content) !== patch.content_sha256)
      reasons.push(`patches/${patch.file}: base patch content digest does not match its registry identity`);
  }

  let source: "tools" | "home" | "node" | undefined;
  let releaseKey: string | undefined;
  let receiptRemoved: PatchRemovalReceipt[] | undefined;
  const receipt = receiptFiles[0];
  const rawReceipt = receipt ? contents[receipt.path]?.candidate : undefined;
  if (receipt && rawReceipt) {
    const decoded = validateReleaseReceipt(rawReceipt, receipt.source);
    if (!decoded.ok) reasons.push(`${receipt.path}: ${decoded.reason}`);
    else {
      source = receipt.source;
      releaseKey = decoded.receipt.releaseKey;
      receiptRemoved = decoded.receipt.removedPatches;
      const basePins = readReleasePins(contents[RELEASE_MERGE_POLICY.upstreamPinsPath]?.base, contents[RELEASE_MERGE_POLICY.poolPinsPath]?.base);
      const candidatePins = readReleasePins(contents[RELEASE_MERGE_POLICY.upstreamPinsPath]?.candidate, contents[RELEASE_MERGE_POLICY.poolPinsPath]?.candidate);
      if (!basePins || !candidatePins) reasons.push("release pin snapshots are missing or invalid");
      else if (!sameJson(decoded.receipt.basePins, basePins) || !sameJson(decoded.receipt.candidatePins, candidatePins))
        reasons.push("release receipt pins do not match the changed source files");
      if (!samePatchRemovalReceipts(
        decoded.receipt.removedPatches,
        manifestRemoved.map(({ identity, content_sha256 }) => ({ identity, content_sha256 })),
      )) reasons.push("release receipt patch identities do not match removed registry records");
      if (receipt.source === "tools" && (!toolsChanged && patchRemovals.length === 0 || homeChanged || nodeChanged))
        reasons.push("tools receipt must describe a tools pin change or patch removal only");
      if (receipt.source === "home" && (!homeChanged || toolsChanged || nodeChanged || patchRemovals.length > 0))
        reasons.push("home receipt must describe a home pin change only");
      if (receipt.source === "node" && (!nodeChanged || toolsChanged || homeChanged || patchRemovals.length > 0))
        reasons.push("node receipt must describe a node pin change only");
    }
  } else if (receipt) reasons.push(`${receipt.path}: receipt content is missing`);

  if (changedUpstream && source !== "tools") reasons.push("upstream pin changes require a tools receipt");
  if (changedPool && source !== "home" && source !== "node") reasons.push("pool pin changes require a home or node receipt");
  if (byName.has(RELEASE_MERGE_POLICY.providerTablePath) && (!homeChanged || source !== "home"))
    reasons.push("provider table changes require a home pin update");
  if ((homeChanged && source !== "home") || (nodeChanged && source !== "node") || (toolsChanged && source !== "tools"))
    reasons.push("changed pins do not match the source receipt");
  if (patchRemovals.length > 0 && source !== "tools") reasons.push("carried patch removals require a tools receipt");
  if (receiptRemoved && !samePatchRemovalReceipts(
    receiptRemoved,
    manifestRemoved.map(({ identity, content_sha256 }) => ({ identity, content_sha256 })),
  )) reasons.push("release receipt patch identities are inconsistent");
  if (receipt && receipt.source === "tools" && !changedUpstream && patchRemovals.length === 0)
    reasons.push("tools receipt has no pin or patch change");
  if (receipt && releaseKey && receipt.path !== `${RELEASE_MERGE_POLICY.releaseReceiptPrefix}${source}.json`)
    reasons.push("release receipt path does not match its source");

  return { allowed: reasons.length === 0, reasons, ...(source ? { source } : {}), ...(releaseKey ? { releaseKey } : {}), ...(receiptRemoved ? { removedPatches: receiptRemoved } : {}) };
}

export function validatePreviewReceipt(
  value: unknown,
  expected: { pullRequest: number; head: string; base: string },
): string[] {
  if (!isRecord(value)) return ["preview receipt is not an object"];
  if (!hasExactKeys(value, ["version", "pullRequest", "head", "base", "smoke", "teardown"])) return ["preview receipt has unexpected fields"];
  const reasons: string[] = [];
  if (value.version !== 1) reasons.push("preview receipt version is unsupported");
  if (value.pullRequest !== expected.pullRequest) reasons.push("preview receipt pull request does not match");
  if (value.head !== expected.head) reasons.push("preview receipt head does not match");
  if (value.base !== expected.base) reasons.push("preview receipt base does not match current main");
  if (value.smoke !== true) reasons.push("preview native smoke is missing");
  if (value.teardown !== true) reasons.push("preview teardown proof is missing");
  return reasons;
}

export function validateCheckRunReceipt(
  value: unknown,
  expected: { repository: string; pullRequest: number; runId: number; runAttempt: number; head: string; base: string },
): string[] {
  if (!isRecord(value)) return ["Check receipt is not an object"];
  if (!hasExactKeys(value, ["version", "repository", "pullRequest", "runId", "runAttempt", "head", "base", "mergeCommit", "parents"]))
    return ["Check receipt has unexpected fields"];

  const reasons: string[] = [];
  if (value.version !== 1) reasons.push("Check receipt version is unsupported");
  if (value.repository !== expected.repository) reasons.push("Check receipt repository does not match");
  if (value.pullRequest !== expected.pullRequest) reasons.push("Check receipt pull request does not match");
  if (value.runId !== expected.runId) reasons.push("Check receipt workflow run does not match");
  if (value.runAttempt !== expected.runAttempt) reasons.push("Check receipt workflow attempt does not match");
  if (value.head !== expected.head) reasons.push("Check receipt head does not match");
  if (value.base !== expected.base) reasons.push("Check receipt base does not match current main");
  if (typeof value.mergeCommit !== "string" || !SHA.test(value.mergeCommit)) reasons.push("Check receipt merge commit is invalid");
  else if (value.mergeCommit === expected.base || value.mergeCommit === expected.head) reasons.push("Check receipt merge commit is not a distinct merge result");
  if (!Array.isArray(value.parents) || value.parents.length !== 2 || value.parents.some((parent) => typeof parent !== "string" || !SHA.test(parent)))
    reasons.push("Check receipt merge parents are invalid");
  else {
    if (value.parents[0] !== expected.base) reasons.push("Check receipt merge result used a different base parent");
    if (value.parents[1] !== expected.head) reasons.push("Check receipt merge result used a different head parent");
  }
  return reasons;
}

function safeRepoPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return sameStringSet(Object.keys(value), keys);
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

