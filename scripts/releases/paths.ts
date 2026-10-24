import type { ChangedFile, Evidence, PatchManifestV3, PatchRecord, SourceComparison } from "./types.ts";

const databasePath = /(^|\/)(migrations?|schema|schema_migration|[^/]*_migration)(\/|\.|$)/i;
const databaseModelPath = /(^|\/)internal\/cluster\//i;
const workflowPath = /(^|\/)[^/]*workflow[^/]*(\/|$)/i;
const ignoredWorkflowArea = /(^|\/)(docs?|e2e|playground|test|tests|__tests__)(\/|$)/i;
const workflowCode = /(?:Cloudflare\.Workflows|WorkflowStep|workflowName|workflowStep|workflowRun|waitForEvent|\.task\s*\(|\.sleep\s*\()/i;
const databaseCode = /(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|schema_migration|migrations?)/i;
const nonRuntimePath = /(^|\/)(docs?|e2e|playground|test|tests|__tests__|marketing)(\/|$)|\.(?:md|mdx|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)$/i;
const runtimeRoot = /^(?:apps\/hosted\/|packages\/|lib\/)/;
const sourceExtension = /\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|sql|prisma|rs|java|kt|swift|c|cc|cpp|h|hpp)$/i;

export type PathState = "unchanged" | "changed" | "unknown";

export function isDatabasePath(path: string): boolean {
  return databasePath.test(path) || databaseModelPath.test(path) || /\.(?:sql|prisma)$/i.test(path);
}

export function isWorkflowPath(path: string): boolean {
  return workflowPath.test(path) && !ignoredWorkflowArea.test(path);
}

export function isPotentialRuntimePath(path: string): boolean {
  return !nonRuntimePath.test(path) && (runtimeRoot.test(path) || sourceExtension.test(path));
}

export function toolsDatabasePathState(path: string): PathState {
  if (isDatabasePath(path)) return "changed";
  return isPotentialRuntimePath(path) ? "unknown" : "unchanged";
}

export function toolsWorkflowPathState(file: ChangedFile): PathState {
  if (isWorkflowPath(file.filename) || file.patch !== undefined && patchTouchesWorkflow(file.patch)) return "changed";
  return isPotentialRuntimePath(file.filename) ? "unknown" : "unchanged";
}

export function nodeDatabasePathState(path: string): PathState {
  if (isDatabasePath(path)) return "changed";
  return isPotentialRuntimePath(path) ? "unknown" : "unchanged";
}

export function patchTouchesDatabase(patch: string): boolean {
  return patch.split("\n").some((line) => /^[-+](?![-+])/.test(line) && databaseCode.test(line.slice(1)));
}

export function patchTouchesWorkflow(patch: string): boolean {
  return patch.split("\n").some((line) => /^[-+](?![-+])/.test(line) && workflowCode.test(line.slice(1)));
}

export function sourceEvidence(
  name: string,
  base: string,
  candidate: string,
  comparison: SourceComparison | undefined,
  assess: (file: ChangedFile) => PathState,
): Evidence["sources"][number] {
  if (base === candidate)
    return { name, state: "unchanged", base, candidate, changedPaths: [] };
  if (!comparison?.complete)
    return { name, state: "unknown", base, candidate, changedPaths: comparison?.files.map((f) => f.filename) ?? [], reason: "source comparison incomplete" };
  const assessed = comparison.files.map((file) => ({ file, state: assess(file) })).filter((item) => item.state !== "unchanged");
  const state = assessed.some((item) => item.state === "changed")
    ? "changed"
    : assessed.some((item) => item.state === "unknown")
      ? "unknown"
      : "unchanged";
  return {
    name,
    state,
    base,
    candidate,
    changedPaths: assessed.map((item) => item.file.filename),
    ...(state === "unknown" ? { reason: "runtime source changed outside a proven database/workflow exclusion" } : {}),
  };
}

export function mergeEvidence(sources: Evidence["sources"]): Evidence {
  return {
    state: sources.some((source) => source.state === "changed")
      ? "changed"
      : sources.some((source) => source.state === "unknown")
        ? "unknown"
        : "unchanged",
    sources,
  };
}

export function patchManifestByIdentity(manifest: PatchManifestV3 | undefined): Map<string, PatchRecord> {
  return new Map((manifest?.patches ?? []).map((patch) => [patch.identity, patch]));
}

export function changedPatchFiles(paths: string[]): string[] {
  return paths.filter((path) => path.startsWith("patches/") && path.endsWith(".patch"));
}

export function localDatabasePaths(paths: string[]): string[] {
  return paths.filter(isDatabasePath);
}

export function localWorkflowPaths(paths: string[]): string[] {
  return paths.filter(isWorkflowPath);
}
