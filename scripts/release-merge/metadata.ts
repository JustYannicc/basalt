import { parsePatchManifest } from "../releases/patch-registry.ts";
import type { PatchManifest } from "../releases/types.ts";

export type ReleasePins = {
  tools: { repository: string; commit: string };
  home: ArtifactPin;
  node: ArtifactPin;
};

export type ArtifactPin = {
  repository: string;
  tag: string;
  commit: string;
  binary: string;
  assets: Record<"amd64" | "arm64", { name: string; sha256: string }>;
};


const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;

export function readReleasePins(upstreamText?: string, poolText?: string): ReleasePins | undefined {
  if (upstreamText === undefined || poolText === undefined) return undefined;
  try {
    const upstream = parseJson(upstreamText);
    const pool = parseJson(poolText);
    if (!isRecord(upstream) || !hasExactKeys(upstream, ["repository", "commit"])) return undefined;
    if (typeof upstream.repository !== "string" || !normalizeRepository(upstream.repository) || typeof upstream.commit !== "string" || !SHA.test(upstream.commit)) return undefined;
    if (!isRecord(pool) || !hasExactKeys(pool, ["format_version", "artifacts"]) || pool.format_version !== 1 || !isRecord(pool.artifacts)) return undefined;
    if (!hasExactKeys(pool.artifacts, ["home", "node"])) return undefined;
    const home = parseArtifactPin(pool.artifacts.home);
    const node = parseArtifactPin(pool.artifacts.node);
    if (!home || !node) return undefined;
    return { tools: { repository: normalizeRepository(upstream.repository)!, commit: upstream.commit }, home, node };
  } catch {
    return undefined;
  }
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function validateUpstreamPins(contents?: { base?: string; candidate?: string }): { ok: boolean; reason: string; changed: boolean } {
  if (!contents?.base || !contents.candidate) return { ok: false, reason: "pin snapshots are missing", changed: false };
  try {
    const base = parseJson(contents.base);
    const candidate = parseJson(contents.candidate);
    if (!isRecord(base) || !isRecord(candidate) || !hasExactKeys(base, ["repository", "commit"]) || !hasExactKeys(candidate, ["repository", "commit"]))
      return { ok: false, reason: "expected repository and commit fields", changed: false };
    if (normalizeRepository(typeof base.repository === "string" ? base.repository : "") !== normalizeRepository(typeof candidate.repository === "string" ? candidate.repository : ""))
      return { ok: false, reason: "repository cannot change", changed: false };
    if (typeof base.commit !== "string" || !SHA.test(base.commit) || typeof candidate.commit !== "string" || !SHA.test(candidate.commit))
      return { ok: false, reason: "commit must be an immutable SHA", changed: false };
    return { ok: true, reason: "", changed: base.commit !== candidate.commit };
  } catch {
    return { ok: false, reason: "invalid JSON", changed: false };
  }
}

export function validatePoolPins(contents?: { base?: string; candidate?: string }): { ok: boolean; reason: string; homeChanged: boolean; nodeChanged: boolean } {
  if (!contents?.base || !contents.candidate) return { ok: false, reason: "pin snapshots are missing", homeChanged: false, nodeChanged: false };
  try {
    const base = readPoolPins(contents.base);
    const candidate = readPoolPins(contents.candidate);
    if (!base || !candidate) return { ok: false, reason: "invalid pool pin schema", homeChanged: false, nodeChanged: false };
    const homeChanged = !sameJson(base.home, candidate.home);
    const nodeChanged = !sameJson(base.node, candidate.node);
    for (const source of ["home", "node"] as const) {
      const before = source === "home" ? base.home : base.node;
      const after = source === "home" ? candidate.home : candidate.node;
      if (before.repository !== after.repository || before.binary !== after.binary)
        return { ok: false, reason: `${source} repository and binary cannot change`, homeChanged: false, nodeChanged: false };
    }
    return { ok: true, reason: "", homeChanged, nodeChanged };
  } catch {
    return { ok: false, reason: "invalid JSON", homeChanged: false, nodeChanged: false };
  }
}

export function removedManifestRecords(contents?: { base?: string; candidate?: string }): { ok: boolean; reason: string; removed: string[] } {
  if (!contents?.base || !contents.candidate) return { ok: false, reason: "manifest snapshots are missing", removed: [] };
  try {
    const base = parseManifest(contents.base);
    const candidate = parseManifest(contents.candidate);
    if (!base || !candidate) return { ok: false, reason: "invalid manifest schema", removed: [] };
    if (base.format_version !== candidate.format_version || base.repository !== candidate.repository)
      return { ok: false, reason: "manifest header cannot change", removed: [] };
    const baseByFile = new Map(base.patches.map((patch) => [patch.file, patch]));
    const candidateNames = new Set(candidate.patches.map((patch) => patch.file));
    if (candidateNames.size !== candidate.patches.length || baseByFile.size !== base.patches.length)
      return { ok: false, reason: "manifest contains duplicate patch records", removed: [] };
    if (candidate.patches.some((patch) => !sameJson(baseByFile.get(patch.file), patch)))
      return { ok: false, reason: "manifest records may only be removed", removed: [] };
    if (!isSubsequence(candidate.patches.map((patch) => patch.file), base.patches.map((patch) => patch.file)))
      return { ok: false, reason: "manifest record order cannot change", removed: [] };
    const removed = base.patches.map((patch) => patch.file).filter((file) => !candidateNames.has(file));
    if (removed.length === 0) return { ok: false, reason: "manifest change removes no records", removed: [] };
    for (const name of removed) {
      const patch = baseByFile.get(name)!;
      if (patch.kind === "overlay")
        return { ok: false, reason: "overlay retirement requires a separate reviewed update", removed: [] };
    }
    return { ok: true, reason: "", removed };
  } catch {
    return { ok: false, reason: "invalid JSON", removed: [] };
  }
}

export function validateReleaseReceipt(text: string, source: "tools" | "home" | "node"):
  | { ok: true; receipt: { schemaVersion: 1; source: string; releaseKey: string; basePins: unknown; candidatePins: unknown; removedPatches: string[] } }
  | { ok: false; reason: string } {
  try {
    const value = parseJson(text);
    if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "source", "releaseKey", "basePins", "candidatePins", "removedPatches"])) return { ok: false, reason: "expected the confirmed release receipt schema" };
    if (value.schemaVersion !== 1 || value.source !== source || typeof value.releaseKey !== "string" || !value.releaseKey.startsWith(`${source}-`) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.releaseKey) || !Array.isArray(value.removedPatches)) return { ok: false, reason: "invalid source, release key, or receipt version" };
    const removedPatches = value.removedPatches;
    if (removedPatches.some((file) => typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/.test(file)) || new Set(removedPatches).size !== removedPatches.length)
      return { ok: false, reason: "invalid removedPatches list" };
    const basePins = readReleasePinsFromValue(value.basePins);
    const candidatePins = readReleasePinsFromValue(value.candidatePins);
    if (!basePins || !candidatePins) return { ok: false, reason: "invalid release pin snapshots" };
    return { ok: true, receipt: { ...value, basePins, candidatePins } as { schemaVersion: 1; source: string; releaseKey: string; basePins: unknown; candidatePins: unknown; removedPatches: string[] } };
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
}

export function validProviderTable(text?: string): boolean {
  if (!text) return false;
  try {
    const value = parseJson(text);
    if (!Array.isArray(value)) return false;
    const ids = new Set<string>();
    return value.every((row) => {
      if (!isRecord(row) || !hasExactKeys(row, ["id", "name"]) || typeof row.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(row.id) || typeof row.name !== "string" || !row.name.trim() || ids.has(row.id)) return false;
      ids.add(row.id);
      return true;
    });
  } catch {
    return false;
  }
}

function readPoolPins(text: string): { home: ArtifactPin; node: ArtifactPin } | undefined {
  const value = parseJson(text);
  if (!isRecord(value) || !hasExactKeys(value, ["format_version", "artifacts"]) || value.format_version !== 1 || !isRecord(value.artifacts) || !hasExactKeys(value.artifacts, ["home", "node"])) return undefined;
  const home = parseArtifactPin(value.artifacts.home);
  const node = parseArtifactPin(value.artifacts.node);
  return home && node ? { home, node } : undefined;
}

function parseArtifactPin(value: unknown): ArtifactPin | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["repository", "tag", "commit", "binary", "assets"]) || !isRecord(value.assets)) return undefined;
  if (!hasExactKeys(value.assets, ["amd64", "arm64"])) return undefined;
  if (typeof value.repository !== "string" || !isRepository(value.repository) || typeof value.tag !== "string" || !value.tag || typeof value.commit !== "string" || !SHA.test(value.commit) || typeof value.binary !== "string" || !value.binary) return undefined;
  const amd64 = parseAsset(value.assets.amd64);
  const arm64 = parseAsset(value.assets.arm64);
  if (!amd64 || !arm64) return undefined;
  return { repository: value.repository, tag: value.tag, commit: value.commit, binary: value.binary, assets: { amd64, arm64 } };
}

function parseAsset(value: unknown): { name: string; sha256: string } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "sha256"]) || typeof value.name !== "string" || !value.name || typeof value.sha256 !== "string" || !DIGEST.test(value.sha256)) return undefined;
  return { name: value.name, sha256: value.sha256 };
}

function parseManifest(text: string): PatchManifest | undefined {
  try { return parsePatchManifest(text); }
  catch { return undefined; }
}

function readReleasePinsFromValue(value: unknown): ReleasePins | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["tools", "home", "node"])) return undefined;
  const tools = value.tools;
  const home = parseArtifactPin(value.home);
  const node = parseArtifactPin(value.node);
  if (!isRecord(tools) || !hasExactKeys(tools, ["repository", "commit"]) || typeof tools.repository !== "string" || !normalizeRepository(tools.repository) || typeof tools.commit !== "string" || !SHA.test(tools.commit) || !home || !node) return undefined;
  return { tools: { repository: normalizeRepository(tools.repository)!, commit: tools.commit }, home, node };
}

function normalizeRepository(value: string): string | undefined {
  const normalized = value
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
  return isRepository(normalized) ? normalized : undefined;
}

function isRepository(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function isSubsequence(candidate: string[], base: string[]): boolean {
  let index = 0;
  for (const value of base) if (candidate[index] === value) index++;
  return index === candidate.length;
}
