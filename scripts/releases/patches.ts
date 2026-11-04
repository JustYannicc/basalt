import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GitHubApi } from "./github.ts";
import { assertPoolCarryManifestContent, patchManifestPath } from "./patch-registry.ts";
import { materializePatchManifest } from "./patch-layout.ts";
import type { PatchManifestV3 } from "./types.ts";

const PATCH_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.patch$/;

export type PatchDecision = {
  identity: string;
  file: string;
  content_sha256: string;
  remove: boolean;
  reason: string;
};

export function readPatchManifest(root: string): PatchManifestV3 {
  const headerPath = join(root, patchManifestPath);
  if (!lstatSync(headerPath).isFile()) throw new Error("Patch header must be a regular file");
  const source = readFileSync(headerPath, "utf8");
  const files = Object.fromEntries(readdirSync(join(root, "patches"))
    .filter((file) => /\.(patch|json)$/.test(file)).map((file) => {
      const path = join(root, "patches", file);
      const regular = lstatSync(path).isFile();
      return [file, { regular, content: regular ? readFileSync(path) : "" }];
    }));
  const manifest = materializePatchManifest(source, files);
  if (manifest.pool_carries) assertPoolCarryManifestContent(manifest, readFileSync(join(root, manifest.pool_carries.manifest)));
  for (const patch of manifest.patches) {
    if (patch.rebased_from === undefined) continue;
    const directory = join(root, "patches/archive", patch.rebased_from_pin!);
    const originalPath = join(directory, patch.file);
    const recordPath = join(directory, patch.file.replace(/\.patch$/, ".json"));
    if (!lstatSync(originalPath).isFile() || !lstatSync(recordPath).isFile())
      throw new Error(`Archived carry must be regular files: ${patch.file}`);
    const digest = createHash("sha256").update(readFileSync(originalPath)).digest("hex");
    const original = JSON.parse(readFileSync(recordPath, "utf8"));
    if (digest !== patch.rebased_from || original.content_sha256 !== digest ||
      original.identity !== patch.identity || original.file !== patch.file)
      throw new Error(`Archived carry provenance mismatch: ${patch.file}`);
  }
  return manifest;
}

export async function decidePatchRemovals(
  manifest: PatchManifestV3,
  activeFiles: string[],
  candidateCommit: string,
  api: Pick<GitHubApi, "get" | "compare">,
): Promise<PatchDecision[]> {
  const active = new Set(activeFiles);
  const pulls = new Map<number, Promise<PullRequest>>();
  const ancestors = new Map<string, Promise<boolean>>();
  const decisions: PatchDecision[] = [];

  for (const patch of manifest.patches) {
    if (!active.has(patch.file)) throw new Error(`Registered patch file is missing: ${patch.file}`);
    const base = {
      identity: patch.identity,
      file: patch.file,
      content_sha256: patch.content_sha256,
    };
    if (patch.kind === "overlay") {
      decisions.push({
        ...base,
        remove: false,
        reason: patch.remove_with ? "overlay-retirement-proof-unavailable" : "overlay-does-not-auto-retire",
      });
      continue;
    }
    if (patch.upstream_pull_request === null) {
      decisions.push({ ...base, remove: false, reason: "no-upstream-pull-request" });
      continue;
    }

    const pullNumber = patch.upstream_pull_request;
    const pull = pulls.get(pullNumber) ?? api.get<PullRequest>(`repos/${manifest.repository}/pulls/${pullNumber}`);
    pulls.set(pullNumber, pull);
    try {
      const detail = await pull;
      if (!detail.merged || !detail.merge_commit_sha) {
        decisions.push({ ...base, remove: false, reason: "upstream-pull-request-not-merged" });
        continue;
      }
      const key = `${detail.merge_commit_sha}:${candidateCommit}`;
      const ancestor = ancestors.get(key) ?? api.compare(manifest.repository, detail.merge_commit_sha, candidateCommit)
        .then((comparison) => comparison.status === "ahead" || comparison.status === "identical");
      ancestors.set(key, ancestor);
      decisions.push(await ancestor
        ? { ...base, remove: true, reason: "merged-commit-in-candidate" }
        : { ...base, remove: false, reason: "merge-commit-not-in-candidate" });
    } catch {
      decisions.push({ ...base, remove: false, reason: "upstream-proof-unavailable" });
    }
  }
  return decisions;
}

export function activePatchFiles(root: string): string[] {
  const directory = join(root, "patches");
  if (!lstatExists(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".patch")).sort().map((file) => {
    if (!PATCH_FILE.test(file) || !lstatSync(join(directory, file)).isFile())
      throw new Error(`Carried patch is not a regular file: ${file}`);
    return file;
  });
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

type PullRequest = { merged: boolean; merge_commit_sha: string | null };
