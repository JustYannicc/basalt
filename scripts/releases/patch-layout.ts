import {
  assertPatchManifestContentMatchesFiles,
  assertPatchManifestMatchesFiles,
  parsePatchManifest,
  parsePatchManifestV3,
} from "./patch-registry.ts";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.ts";
import type { PatchManifest, PatchManifestV3, PatchRecord } from "./types.ts";

export type PatchHeader = Omit<PatchManifestV3, "format_version" | "patches"> & {
  format_version: 4;
};
export type RegistryFile = { content: string | Uint8Array; regular: boolean };

export function patchRecordPath(file: string): string {
  return `patches/${file.replace(/\.patch$/, ".json")}`;
}

export function parseRegistrySource(source: string): PatchManifest | PatchHeader {
  const value = parseJsonRejectingDuplicateKeys(source);
  if (
    value !== null &&
    typeof value === "object" &&
    "format_version" in value &&
    value.format_version === 4
  ) {
    if ("patches" in value) throw new Error("Format 4 header cannot contain patches");
    // Reuse record and binding validation without changing the historical parser.
    parsePatchManifestV3(JSON.stringify({ ...value, format_version: 3, patches: [] }));
    return value as PatchHeader;
  }
  return parsePatchManifest(source);
}

export function parsePatchRecord(source: string, file: string): PatchRecord {
  const record = parseJsonRejectingDuplicateKeys(source);
  const manifest = parsePatchManifestV3(
    JSON.stringify({ format_version: 3, repository: "record/validation", patches: [record] }),
  );
  const patch = manifest.patches[0]!;
  if (patchRecordPath(patch.file) !== `patches/${file}`)
    throw new Error(`Patch record stem does not match: ${file}`);
  return patch;
}

/** Both disk and exact-commit readers provide the same complete directory snapshot. */
export function materializePatchManifest(
  source: string,
  files: Record<string, RegistryFile>,
): PatchManifestV3 {
  const parsed = parseRegistrySource(source);
  const patches = Object.keys(files)
    .filter((file) => file.endsWith(".patch"))
    .sort();
  const records = Object.keys(files)
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of [...patches, ...records]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(patch|json)$/.test(file) || !files[file]!.regular)
      throw new Error(`Carry is not a regular file: ${file}`);
  }
  if (parsed.format_version !== 4 && records.length)
    throw new Error("Legacy registry cannot contain sidecar records");
  if (parsed.format_version === 2) throw new Error("Format 3 or 4 patch registry is required");
  let manifest: PatchManifestV3;
  if (parsed.format_version === 4) {
    if (
      JSON.stringify(records) !==
      JSON.stringify(patches.map((file) => file.replace(/\.patch$/, ".json")).sort())
    )
      throw new Error("Missing or orphan patch record");
    const combined = patches.map((file) => {
      const name = file.replace(/\.patch$/, ".json");
      return parsePatchRecord(Buffer.from(files[name]!.content).toString("utf8"), name);
    });
    manifest = parsePatchManifestV3(
      JSON.stringify({ ...parsed, format_version: 3, patches: combined }),
    );
  } else manifest = parsed;
  assertPatchManifestMatchesFiles(manifest, patches);
  assertPatchManifestContentMatchesFiles(
    manifest,
    Object.fromEntries(patches.map((file) => [file, Buffer.from(files[file]!.content)])),
  );
  return manifest;
}

export function serializePatchLayout(manifest: PatchManifestV3): Map<string, string> {
  const { patches, ...header } = manifest;
  return new Map([
    [
      "scripts/releases/patches.json",
      `${JSON.stringify({ ...header, format_version: 4 }, null, 2)}\n`,
    ],
    ...patches.map((patch): [string, string] => [
      patchRecordPath(patch.file),
      `${JSON.stringify(patch, null, 2)}\n`,
    ]),
  ]);
}
