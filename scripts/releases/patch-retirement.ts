import {
  removedPatchRecords,
  sha256PatchContent,
  type PatchManifestRemoval,
} from "./patch-registry.ts";
import { parsePatchRecord, parseRegistrySource } from "./patch-layout.ts";

type Contents = Record<string, { base?: string; candidate?: string }>;
type File = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
};

export function inspectPatchRetirement(
  files: File[],
  contents: Contents,
): {
  removed: PatchManifestRemoval[];
  reasons: string[];
} {
  const headerPath = "scripts/releases/patches.json";
  const header = contents[headerPath];
  const records = files.filter(({ filename }) => /^patches\/.*\.json$/.test(filename));
  const changedHeader = files.some(({ filename }) => filename === headerPath);
  try {
    if (!header?.base || !header.candidate) throw new Error("patch registry snapshots are missing");
    const base = parseRegistrySource(header.base);
    const candidate = parseRegistrySource(header.candidate);
    if (base.format_version !== candidate.format_version)
      throw new Error("automatic patch registry migration is forbidden");
    if (base.format_version !== 4) {
      if (records.length) throw new Error("legacy registry cannot contain sidecar changes");
      if (!changedHeader) {
        if (header.base !== header.candidate) throw new Error("unlisted patch header change");
        return { removed: [], reasons: [] };
      }
      if (files.find(({ filename }) => filename === headerPath)?.status !== "modified")
        throw new Error("legacy patch header must be modified in place");
      const result = removedPatchRecords(header);
      if (!result.ok) throw new Error(result.reason);
      return { removed: result.removed, reasons: [] };
    }
    if (header.base !== header.candidate || changedHeader)
      throw new Error("format 4 header must remain byte-identical");
    const removed: PatchManifestRemoval[] = [];
    for (const file of records) {
      if (
        file.status !== "removed" ||
        file.additions !== 0 ||
        file.deletions <= 0 ||
        file.changes !== file.deletions
      )
        throw new Error("patch records may only be removed in matching pairs");
      const recordContent = contents[file.filename];
      if (!recordContent?.base || recordContent.candidate !== undefined)
        throw new Error("deleted patch record snapshots are invalid");
      const patch = parsePatchRecord(recordContent.base, file.filename.slice("patches/".length));
      if (patch.kind !== "upstream")
        throw new Error("overlay retirement requires a separate reviewed update");
      const patchPath = `patches/${patch.file}`;
      const body = files.find(({ filename }) => filename === patchPath);
      const content = contents[patchPath];
      if (
        body?.status !== "removed" ||
        content?.base === undefined ||
        content.candidate !== undefined
      )
        throw new Error("patch and record must both be deleted");
      if (sha256PatchContent(content.base) !== patch.content_sha256)
        throw new Error("base patch digest does not match its record");
      removed.push(patch);
    }
    return { removed, reasons: [] };
  } catch (error) {
    return {
      removed: [],
      reasons: [error instanceof Error ? error.message : "invalid patch retirement"],
    };
  }
}

export function assertCarryDeletions(
  rows: string[][],
  source: string,
  sidecarsRequired: boolean,
): void {
  const deleted = new Set(rows.filter(([status]) => status === "D").map((row) => row.at(-1)!));
  for (const [status, ...names] of rows) {
    const path = names.at(-1)!;
    if (!path.startsWith("patches/")) continue;
    if (source !== "tools" || status !== "D")
      throw new Error("Only tools updates may delete carried patches and records");
    const paired = path.endsWith(".json")
      ? path.replace(/\.json$/, ".patch")
      : path.replace(/\.patch$/, ".json");
    if ((sidecarsRequired || path.endsWith(".json")) && !deleted.has(paired))
      throw new Error("Patch and record deletions must be paired");
  }
}
