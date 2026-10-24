import type { Evidence, PatchManifestV3, PatchRecord } from "./types.ts";
import { patchMappingKey, patchOriginKey, sha256PatchContent } from "./patch-registry.ts";
import { isPotentialRuntimePath, patchTouchesDatabase, patchTouchesWorkflow } from "./paths.ts";

export type PatchClassificationInput = {
  baseGitCommit: string;
  candidateGitCommit: string;
  basePatchManifest?: PatchManifestV3;
  candidatePatchManifest?: PatchManifestV3;
  patchContents?: Record<string, { base?: string | Uint8Array; candidate?: string | Uint8Array }>;
};

type ObservedPatch = {
  record: PatchRecord;
  mapping: string;
  origin: string;
  content: string;
  path: string;
};

export function classifyPatchChanges(
  input: PatchClassificationInput,
): { database?: Evidence["sources"][number]; workflow?: Evidence["sources"][number] } {
  const contents = input.patchContents ?? {};
  const paths = Object.keys(contents).sort();
  if (!paths.length) return {};

  const before: ObservedPatch[] = [];
  const after: ObservedPatch[] = [];
  const unknown = new Set<string>();
  for (const path of paths) {
    const pair = contents[path]!;
    if (pair.base !== undefined) {
      const record = recordForContent(pair.base, input.basePatchManifest)
        ?? (!input.basePatchManifest ? recordForContent(pair.base, input.candidatePatchManifest) : undefined);
      if (record) before.push(observed(record, input.basePatchManifest?.repository ?? input.candidatePatchManifest!.repository, pair.base, path));
      else unknown.add(path);
    }
    if (pair.candidate !== undefined) {
      const record = recordForContent(pair.candidate, input.candidatePatchManifest);
      if (record) after.push(observed(record, input.candidatePatchManifest!.repository, pair.candidate, path));
      else unknown.add(path);
    }
  }

  const identitySets = new Set([...before, ...after].map(({ record }) => record.identity));
  const changed: ObservedPatch[] = [];

  for (const oldRow of before) {
    for (const newRow of after) {
      if (oldRow.record.identity !== newRow.record.identity &&
        oldRow.record.content_sha256 === newRow.record.content_sha256 &&
        oldRow.origin === newRow.origin) {
        unknown.add(oldRow.path);
        unknown.add(newRow.path);
      }
    }
  }

  for (const identity of identitySets) {
    const oldRows = before.filter(({ record }) => record.identity === identity);
    const newRows = after.filter(({ record }) => record.identity === identity);
    const oldMapping = uniqueMapping(oldRows);
    const newMapping = uniqueMapping(newRows);
    if (oldRows.length && newRows.length && oldMapping !== newMapping) {
      for (const row of [...oldRows, ...newRows]) unknown.add(row.path);
      continue;
    }
    if (samePatchState(oldRows, newRows)) continue;
    changed.push(...oldRows, ...newRows);
  }

  const databasePaths = new Set<string>();
  const workflowPaths = new Set<string>();
  for (const row of changed) {
    const pairedContent = [...before, ...after]
      .filter((candidate) => candidate.record.identity === row.record.identity)
      .map((candidate) => candidate.content)
      .join("\n");
    if (row.record.database_sensitive || patchTouchesDatabase(pairedContent)) databasePaths.add(`patches/${row.path}`);
    if (row.record.workflow_sensitive || patchTouchesWorkflow(pairedContent)) workflowPaths.add(`patches/${row.path}`);
    if (patchHasRuntimePath(pairedContent) && (
      !row.record.database_sensitive && !patchTouchesDatabase(pairedContent) ||
      !row.record.workflow_sensitive && !patchTouchesWorkflow(pairedContent)
    ))
      unknown.add(row.path);
  }

  const unknownPaths = [...unknown].map((path) => `patches/${path}`).sort();
  const result = (
    state: Evidence["sources"][number]["state"],
    changedPaths: string[],
    reason?: string,
  ): Evidence["sources"][number] => ({
    name: "carried patches",
    state,
    base: input.baseGitCommit,
    candidate: input.candidateGitCommit,
    changedPaths,
    ...(reason ? { reason } : {}),
  });

  return {
    ...(databasePaths.size || unknownPaths.length ? {
      database: result(
        databasePaths.size ? "changed" : "unknown",
        databasePaths.size ? [...databasePaths].sort() : unknownPaths,
        unknownPaths.length ? "changed patch has no verified content mapping" : undefined,
      ),
    } : {}),
    ...(workflowPaths.size || unknownPaths.length ? {
      workflow: result(
        workflowPaths.size ? "changed" : "unknown",
        workflowPaths.size ? [...workflowPaths].sort() : unknownPaths,
        unknownPaths.length ? "changed patch has no verified content mapping" : undefined,
      ),
    } : {}),
  };
}

function recordForContent(content: string | Uint8Array, manifest?: PatchManifestV3): PatchRecord | undefined {
  if (!manifest) return undefined;
  const digest = sha256PatchContent(content);
  return manifest.patches.find((record) => record.content_sha256 === digest);
}

function observed(record: PatchRecord, repository: string, content: string | Uint8Array, path: string): ObservedPatch {
  return {
    record,
    mapping: patchMappingKey(repository, record),
    origin: patchOriginKey(repository, record),
    content: typeof content === "string" ? content : Buffer.from(content).toString("utf8"),
    path,
  };
}

function uniqueMapping(rows: ObservedPatch[]): string | undefined {
  const mappings = new Set(rows.map(({ mapping }) => mapping));
  return mappings.size === 1 ? mappings.values().next().value as string : undefined;
}

function samePatchState(before: ObservedPatch[], after: ObservedPatch[]): boolean {
  if (before.length !== after.length) return false;
  const key = ({ record, mapping }: ObservedPatch) =>
    JSON.stringify([
      record.identity,
      mapping,
      record.content_sha256,
      record.database_sensitive,
      record.workflow_sensitive,
    ]);
  const oldKeys = before.map(key).sort();
  const newKeys = after.map(key).sort();
  return oldKeys.every((value, index) => value === newKeys[index]);
}

function patchHasRuntimePath(patch: string): boolean {
  return patch.split("\n").some((line) => {
    const match = /^diff --git a\/([^ ]+) b\//.exec(line);
    return match ? isPotentialRuntimePath(match[1]!) : false;
  });
}
