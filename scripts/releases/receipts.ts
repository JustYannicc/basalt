import { readReleasePins } from "../release-merge/metadata.ts";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.ts";
import type { PatchRemovalReceipt, ReleasePins } from "./types.ts";

const RELEASE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PATCH_IDENTITY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCES = new Set(["tools", "home", "node"]);

export type ReleaseReceipt = {
  schemaVersion: 2;
  source: "tools" | "home" | "node";
  releaseKey: string;
  basePins: ReleasePins;
  candidatePins: ReleasePins;
  removedPatches: PatchRemovalReceipt[];
};

export function validateReleaseReceipt(text: string, source: ReleaseReceipt["source"]):
  | { ok: true; receipt: ReleaseReceipt }
  | { ok: false; reason: string } {
  try {
    const value = parseJsonRejectingDuplicateKeys(text);
    if (!isRecord(value) || !hasExactKeys(value, [
      "schemaVersion", "source", "releaseKey", "basePins", "candidatePins", "removedPatches",
    ])) return { ok: false, reason: "expected the format 3 release receipt schema" };
    if (value.schemaVersion !== 2 || value.source !== source || !SOURCES.has(String(value.source)) ||
      typeof value.releaseKey !== "string" || !value.releaseKey.startsWith(`${source}-`) ||
      !RELEASE_KEY.test(value.releaseKey) || !Array.isArray(value.removedPatches))
      return { ok: false, reason: "invalid source, release key, or receipt version" };

    const removedPatches: PatchRemovalReceipt[] = [];
    const identities = new Set<string>();
    for (const item of value.removedPatches) {
      if (!isRecord(item) || !hasExactKeys(item, ["identity", "content_sha256"]) ||
        typeof item.identity !== "string" || !PATCH_IDENTITY.test(item.identity) ||
        typeof item.content_sha256 !== "string" || !SHA256.test(item.content_sha256) ||
        identities.has(item.identity))
        return { ok: false, reason: "invalid or duplicate removed patch identity" };
      identities.add(item.identity);
      removedPatches.push({ identity: item.identity, content_sha256: item.content_sha256 });
    }
    if (!isSorted(removedPatches.map(({ identity }) => identity)))
      return { ok: false, reason: "removed patch identities must be sorted" };

    const basePins = readPins(value.basePins);
    const candidatePins = readPins(value.candidatePins);
    if (!basePins || !candidatePins) return { ok: false, reason: "invalid release pin snapshots" };
    return {
      ok: true,
      receipt: {
        schemaVersion: 2,
        source,
        releaseKey: value.releaseKey,
        basePins,
        candidatePins,
        removedPatches,
      },
    };
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
}

export function samePatchRemovalReceipts(left: PatchRemovalReceipt[], right: PatchRemovalReceipt[]): boolean {
  const byIdentity = (a: PatchRemovalReceipt, b: PatchRemovalReceipt) => a.identity.localeCompare(b.identity);
  const sortedLeft = [...left].sort(byIdentity);
  const sortedRight = [...right].sort(byIdentity);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((item, index) =>
    item.identity === sortedRight[index]?.identity &&
    item.content_sha256 === sortedRight[index]?.content_sha256);
}

function readPins(value: unknown): ReleasePins | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["tools", "home", "node"])) return undefined;
  return readReleasePins(
    JSON.stringify(value.tools),
    JSON.stringify({ format_version: 1, artifacts: { home: value.home, node: value.node } }),
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.length === Object.keys(value).length && keys.every((key) => Object.hasOwn(value, key));
}

function isSorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
