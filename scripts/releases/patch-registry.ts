import { createHash } from "node:crypto";
import type { LegacyPatchManifest, PatchManifest, PatchManifestV3, PatchRecord } from "./types.ts";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.ts";

const PATCH_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.patch$/;
const IDENTITY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const patchManifestPath = "scripts/releases/patches.json";

export type PatchManifestRemoval = {
  identity: string;
  file: string;
  content_sha256: string;
  kind: PatchRecord["kind"];
};

/** Parses v2 only for historical readers. Release update paths must call parsePatchManifestV3. */
export function parsePatchManifest(source: string): PatchManifest {
  const manifest = parseJsonRejectingDuplicateKeys(source) as unknown;
  validateManifest(manifest);
  return manifest;
}

export function parsePatchManifestV3(source: string): PatchManifestV3 {
  const manifest = parsePatchManifest(source);
  if (manifest.format_version !== 3) throw new Error("Format 3 patch registry is required");
  return manifest;
}

export function assertPatchManifestMatchesFiles(manifest: PatchManifestV3, activeFiles: string[]): void {
  const tracked = manifest.patches.map((patch) => patch.file).sort();
  const actual = [...activeFiles].sort();
  if (JSON.stringify(tracked) !== JSON.stringify(actual))
    throw new Error("Carried patch manifest does not match the patches directory");
}

export function assertPatchManifestContentMatchesFiles(
  manifest: PatchManifestV3,
  contentByFile: Record<string, Uint8Array>,
): void {
  for (const patch of manifest.patches) {
    const content = contentByFile[patch.file];
    if (!content) throw new Error(`Registered patch content is missing: ${patch.file}`);
    const actual = sha256PatchContent(content);
    if (actual !== patch.content_sha256)
      throw new Error(`Patch content digest does not match registry identity: ${patch.identity}`);
  }
}

export function sha256PatchContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function patchMappingKey(repository: string, patch: PatchRecord): string {
  return JSON.stringify({ identity: patch.identity, origin: patchOriginKey(repository, patch) });
}

export function patchOriginKey(repository: string, patch: PatchRecord): string {
  return JSON.stringify({
    repository,
    kind: patch.kind,
    upstream_pull_request: patch.upstream_pull_request,
    upstream_issue: patch.upstream_issue ?? null,
  });
}

/** Validates that an automated tools update removes whole upstream records only. */
export function removedPatchRecords(
  contents?: { base?: string; candidate?: string },
): { ok: true; removed: PatchManifestRemoval[] } | { ok: false; reason: string; removed: [] } {
  if (!contents?.base || !contents.candidate)
    return { ok: false, reason: "manifest snapshots are missing", removed: [] };
  try {
    const base = parsePatchManifestV3(contents.base);
    const candidate = parsePatchManifestV3(contents.candidate);
    if (base.repository !== candidate.repository)
      return { ok: false, reason: "manifest repository cannot change", removed: [] };

    const baseByIdentity = new Map(base.patches.map((patch) => [patch.identity, patch]));
    const candidateIdentities = new Set(candidate.patches.map((patch) => patch.identity));
    if (candidate.patches.some((patch) => !sameJson(baseByIdentity.get(patch.identity), patch)))
      return { ok: false, reason: "manifest records may only be removed", removed: [] };
    if (!isSubsequence(candidate.patches.map((patch) => patch.identity), base.patches.map((patch) => patch.identity)))
      return { ok: false, reason: "manifest record order cannot change", removed: [] };

    const removed = base.patches.filter((patch) => !candidateIdentities.has(patch.identity));
    if (!removed.length) return { ok: false, reason: "manifest change removes no records", removed: [] };
    if (removed.some((patch) => patch.kind !== "upstream"))
      return { ok: false, reason: "overlay retirement requires a separate reviewed update", removed: [] };
    return {
      ok: true,
      removed: removed.map(({ identity, file, content_sha256, kind }) => ({ identity, file, content_sha256, kind })),
    };
  } catch {
    return { ok: false, reason: "invalid format 3 patch manifest", removed: [] };
  }
}

export function updatedManifest(manifest: PatchManifestV3, removedIdentities: Set<string>): PatchManifestV3 {
  return { ...manifest, patches: manifest.patches.filter((patch) => !removedIdentities.has(patch.identity)) };
}

function validateManifest(value: unknown): asserts value is PatchManifest {
  if (!isRecord(value) || typeof value.format_version !== "number" ||
    typeof value.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    !Array.isArray(value.patches))
    throw new Error("Invalid scripts/releases/patches.json manifest");
  if (value.format_version === 2) {
    validateLegacyManifest(value);
    return;
  }
  if (value.format_version !== 3 || !hasExactKeys(value, ["format_version", "repository", "patches"]))
    throw new Error("Invalid scripts/releases/patches.json manifest");

  const identities = new Set<string>();
  const files = new Set<string>();
  const digests = new Set<string>();
  for (const patch of value.patches) {
    if (!isPatchRecord(patch) || identities.has(patch.identity) || files.has(patch.file) || digests.has(patch.content_sha256))
      throw new Error("Invalid or duplicate format 3 patch record");
    identities.add(patch.identity);
    files.add(patch.file);
    digests.add(patch.content_sha256);
  }
}

function validateLegacyManifest(value: Record<string, unknown>): asserts value is LegacyPatchManifest {
  if (!hasExactKeys(value, ["format_version", "repository", "patches"]) || !Array.isArray(value.patches))
    throw new Error("Invalid legacy patch manifest");
  const names = new Set<string>();
  for (const patch of value.patches) {
    if (!isLegacyPatchRecord(patch) || names.has(patch.file))
      throw new Error("Invalid or duplicate legacy patch record");
    names.add(patch.file);
  }
}

function isPatchRecord(value: unknown): value is PatchRecord {
  if (!isRecord(value) || typeof value.identity !== "string" || !IDENTITY.test(value.identity) ||
    typeof value.file !== "string" || !PATCH_FILE.test(value.file) ||
    typeof value.content_sha256 !== "string" || !SHA256.test(value.content_sha256) ||
    typeof value.database_sensitive !== "boolean" || typeof value.workflow_sensitive !== "boolean") return false;
  const common = ["identity", "file", "content_sha256", "kind", "upstream_pull_request", "database_sensitive", "workflow_sensitive"];
  if (value.upstream_issue !== undefined && !validPositiveInteger(value.upstream_issue)) return false;
  if (value.kind === "upstream")
    return hasOnlyKeys(value, common, ["upstream_issue"]) && validPullRequest(value.upstream_pull_request);
  if (value.kind !== "overlay" || value.upstream_pull_request !== null ||
    !hasOnlyKeys(value, common, ["upstream_issue", "remove_with", "requires"])) return false;
  const hasRemovalCondition = value.remove_with !== undefined || value.requires !== undefined;
  return !hasRemovalCondition ||
    typeof value.remove_with === "string" && value.remove_with !== value.identity && IDENTITY.test(value.remove_with) &&
    typeof value.requires === "string" && value.requires.length > 0 && value.requires.length <= 240 && !/[\r\n\0]/.test(value.requires);
}

function isLegacyPatchRecord(value: unknown): value is LegacyPatchManifest["patches"][number] {
  if (!isRecord(value) || typeof value.file !== "string" || !PATCH_FILE.test(value.file) ||
    typeof value.database_sensitive !== "boolean" || typeof value.workflow_sensitive !== "boolean") return false;
  const common = ["file", "kind", "upstream_pull_request", "database_sensitive", "workflow_sensitive"];
  if (value.kind === "upstream") return hasExactKeys(value, common) && validPullRequest(value.upstream_pull_request);
  if (value.kind !== "overlay" || value.upstream_pull_request !== null ||
    !hasOnlyKeys(value, common, ["upstream_issue", "remove_with", "requires"])) return false;
  if (value.upstream_issue !== undefined && !validPositiveInteger(value.upstream_issue)) return false;
  const hasRemovalCondition = value.remove_with !== undefined || value.requires !== undefined;
  return !hasRemovalCondition ||
    typeof value.remove_with === "string" && value.remove_with !== value.file && PATCH_FILE.test(value.remove_with) &&
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function isSubsequence(candidate: string[], base: string[]): boolean {
  let cursor = 0;
  return candidate.every((identity) => {
    const index = base.indexOf(identity, cursor);
    if (index < 0) return false;
    cursor = index + 1;
    return true;
  });
}
