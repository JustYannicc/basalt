import type { Evidence, PatchManifestV3, PatchRecord } from "./types.ts";
import { patchMappingKey, patchOriginKey, sha256PatchContent } from "./patch-registry.ts";
import { patchDelta } from "./patch-diff.ts";
import { databaseRules, isDependencyFile, workflowRules, type AreaRules } from "./carry-rules.ts";
import { isInertPath } from "./paths.ts";

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
  /** Patch text; `null` when the bytes are not UTF-8. */
  content: string | null;
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
  const changed: Array<{ oldRows: ObservedPatch[]; newRows: ObservedPatch[] }> = [];

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
    changed.push({ oldRows, newRows });
  }

  const database = new Findings();
  const workflow = new Findings();
  for (const { oldRows, newRows } of changed) {
    const rows = [...oldRows, ...newRows];
    const paths = [...new Set(rows.map(({ path }) => `patches/${path}`))];
    const impact = carryImpact(joined(oldRows), joined(newRows));
    database.add(paths, rows.some(({ record }) => record.database_sensitive)
      ? { state: "changed", detail: "is marked database-sensitive in the registry" }
      : impact.database);
    workflow.add(paths, rows.some(({ record }) => record.workflow_sensitive)
      ? { state: "changed", detail: "is marked Workflow-sensitive in the registry" }
      : impact.workflow);
  }

  const unknownPaths = [...unknown].map((path) => `patches/${path}`).sort();
  const result = (findings: Findings): Evidence["sources"][number] | undefined => {
    const changedPaths = [...findings.changed].sort();
    const unknownAll = [...new Set([...unknownPaths, ...findings.unknown])].sort();
    if (!changedPaths.length && !unknownAll.length) return undefined;
    const reasons = [
      ...(unknownPaths.length ? ["changed patch has no verified content mapping"] : []),
      ...findings.reasons,
    ];
    return {
      name: "carried patches",
      state: changedPaths.length ? "changed" : "unknown",
      base: input.baseGitCommit,
      candidate: input.candidateGitCommit,
      changedPaths: changedPaths.length ? changedPaths : unknownAll,
      ...(reasons.length ? { reason: reasons.join("; ") } : {}),
    };
  };

  const databaseEvidence = result(database);
  const workflowEvidence = result(workflow);
  return {
    ...(databaseEvidence ? { database: databaseEvidence } : {}),
    ...(workflowEvidence ? { workflow: workflowEvidence } : {}),
  };
}

export type CarryImpact = { state: "changed" | "unchanged" | "unknown"; detail?: string };

class Findings {
  readonly changed = new Set<string>();
  readonly unknown = new Set<string>();
  readonly reasons: string[] = [];

  add(paths: string[], impact: CarryImpact): void {
    if (impact.state === "unchanged") return;
    for (const path of paths) (impact.state === "changed" ? this.changed : this.unknown).add(path);
    this.reasons.push(`${paths.join(", ")} ${impact.detail}`);
  }
}

/**
 * Database and Workflow impact of a carry's content change. Only upstream files whose effective
 * content differs count. Such a file is database-changing when its path, a changed line, a
 * template literal holding a changed line, or a changed dependency matches the database rules
 * (`carry-rules.ts`), and Workflow-changing likewise. A change this cannot see into, an unbounded
 * template without a database keyword, or any other dependency version change is unknown.
 */
export function carryImpact(before: string | null, after: string | null): { database: CarryImpact; workflow: CarryImpact } {
  const delta = patchDelta(before, after);
  if (!delta.ok) {
    const unknown: CarryImpact = { state: "unknown", detail: `cannot be classified: ${delta.reason}` };
    return { database: unknown, workflow: unknown };
  }
  const judge = (rules: AreaRules): CarryImpact => {
    const hits: string[] = [];
    const opaque: string[] = [];
    for (const file of delta.files) {
      // An inert file is skipped only when every line of its change is visible.
      if (!file.opaque && file.rulePaths.length && file.rulePaths.every(isInertPath)) continue;
      const dependencies = file.rulePaths.some(isDependencyFile) ? file.changed : [];
      const sql = rules.templates ? file.blocks : [];
      if (file.rulePaths.some(rules.isPath) || file.lines.some(rules.isCode) ||
        sql.some((block) => block.lines.some(rules.isCode)) ||
        dependencies.some((line) => rules.packages.test(line)))
        hits.push(file.path);
      else if (file.opaque) opaque.push(`${file.path} (${file.opaque})`);
      else if (dependencies.length) opaque.push(`${file.path} (dependency versions changed)`);
      else if (sql.some((block) => !block.bounded)) opaque.push(`${file.path} (template literal bounds not visible)`);
    }
    if (hits.length) return { state: "changed", detail: `touches ${rules.name} code in ${hits.join(", ")}` };
    if (opaque.length) return { state: "unknown", detail: `hides a change in ${opaque.join(", ")}` };
    return { state: "unchanged" };
  };
  return { database: judge(databaseRules), workflow: judge(workflowRules) };
}

function joined(rows: ObservedPatch[]): string | null {
  let text = "";
  for (const { content } of rows) {
    if (content === null) return null;
    text += content && !content.endsWith("\n") ? `${content}\n` : content;
  }
  return text;
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
    content: typeof content === "string" ? content : decodeUtf8(content),
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

function decodeUtf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}
