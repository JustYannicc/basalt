import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PatchManifest, PatchRecord } from "./types.ts";
import { GitHubApi } from "./github.ts";

export const patchManifestPath = "scripts/releases/patches.json";

export type PatchDecision = { file: string; remove: boolean; reason: string };

export function readPatchManifest(root: string): PatchManifest {
  const manifest = JSON.parse(readFileSync(join(root, patchManifestPath), "utf8")) as unknown;
  validateManifest(manifest);
  assertPatchManifestMatchesFiles(manifest, activePatchFiles(root));
  return manifest;
}

export function parsePatchManifest(source: string): PatchManifest {
  const manifest = JSON.parse(source) as unknown;
  validateManifest(manifest);
  return manifest;
}

export async function decidePatchRemovals(
  manifest: PatchManifest,
  activeFiles: string[],
  candidateCommit: string,
  api: Pick<GitHubApi, "get" | "compare">,
): Promise<PatchDecision[]> {
  const active = new Set(activeFiles);
  const pulls = new Map<number, Promise<PullRequest>>();
  const ancestors = new Map<string, Promise<boolean>>();
  const decisions: PatchDecision[] = [];

  for (const patch of manifest.patches) {
    if (!active.has(patch.file)) continue;
    if (patch.kind === "overlay") {
      decisions.push({
        file: patch.file,
        remove: false,
        reason: patch.remove_with ? "overlay-retirement-proof-unavailable" : "overlay-does-not-auto-retire",
      });
      continue;
    }
    if (patch.upstream_pull_request === null) {
      decisions.push({ file: patch.file, remove: false, reason: "no-upstream-pull-request" });
      continue;
    }

    const pullNumber = patch.upstream_pull_request;
    const pull = pulls.get(pullNumber) ?? api.get<PullRequest>(`repos/${manifest.repository}/pulls/${pullNumber}`);
    pulls.set(pullNumber, pull);
    try {
      const detail = await pull;
      if (!detail.merged || !detail.merge_commit_sha) {
        decisions.push({ file: patch.file, remove: false, reason: "upstream-pull-request-not-merged" });
        continue;
      }
      const key = `${detail.merge_commit_sha}:${candidateCommit}`;
      const ancestor = ancestors.get(key) ?? api.compare(manifest.repository, detail.merge_commit_sha, candidateCommit)
        .then((comparison) => comparison.status === "ahead" || comparison.status === "identical");
      ancestors.set(key, ancestor);
      decisions.push(await ancestor
        ? { file: patch.file, remove: true, reason: "merged-commit-in-candidate" }
        : { file: patch.file, remove: false, reason: "merge-commit-not-in-candidate" });
    } catch {
      decisions.push({ file: patch.file, remove: false, reason: "upstream-proof-unavailable" });
    }
  }
  return decisions;
}

export function activePatchFiles(root: string): string[] {
  const directory = join(root, "patches");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".patch")).sort();
}

export function assertPatchManifestMatchesFiles(manifest: PatchManifest, activeFiles: string[]): void {
  const tracked = manifest.patches.map((patch) => patch.file).sort();
  const actual = [...activeFiles].sort();
  if (JSON.stringify(tracked) !== JSON.stringify(actual))
    throw new Error("Carried patch manifest does not match the patches directory");
}

export function updatedManifest(manifest: PatchManifest, removed: Set<string>): PatchManifest {
  return { ...manifest, patches: manifest.patches.filter((patch) => !removed.has(patch.file)) };
}

function validateManifest(value: unknown): asserts value is PatchManifest {
  if (!isRecord(value) || !hasExactKeys(value, ["format_version", "repository", "patches"]) ||
    value.format_version !== 2 || typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) || !Array.isArray(value.patches))
    throw new Error("Invalid scripts/releases/patches.json manifest");
  const names = new Set<string>();
  for (const patch of value.patches) {
    if (!isPatchRecord(patch) || names.has(patch.file)) throw new Error("Invalid or duplicate carried patch record");
    names.add(patch.file);
  }
}

function isPatchRecord(value: unknown): value is PatchRecord {
  if (!isRecord(value) || typeof value.file !== "string" || !/^[0-9A-Za-z_.-]+\.patch$/.test(value.file) ||
    typeof value.database_sensitive !== "boolean" || typeof value.workflow_sensitive !== "boolean") return false;
  const common = ["file", "kind", "upstream_pull_request", "database_sensitive", "workflow_sensitive"];
  if (value.kind === "upstream") {
    return hasExactKeys(value, common) && validPullRequest(value.upstream_pull_request);
  }
  if (value.kind !== "overlay" || value.upstream_pull_request !== null ||
    !hasOnlyKeys(value, common, ["upstream_issue", "remove_with", "requires"])) return false;
  if (value.upstream_issue !== undefined && !validPositiveInteger(value.upstream_issue)) return false;
  const hasRemovalCondition = value.remove_with !== undefined || value.requires !== undefined;
  return !hasRemovalCondition ||
    typeof value.remove_with === "string" && value.remove_with !== value.file && /^[0-9A-Za-z_.-]+\.patch$/.test(value.remove_with) &&
    typeof value.requires === "string" && value.requires.length > 0 && value.requires.length <= 240 && !/[\r\n\0]/.test(value.requires);
}

function validPullRequest(value: unknown): boolean {
  return value === null || validPositiveInteger(value);
}

function validPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.length === Object.keys(value).length && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type PullRequest = { merged: boolean; merge_commit_sha: string | null };

