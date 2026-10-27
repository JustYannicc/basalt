import type { ChangedFile, Evidence, PatchManifestV3, PatchRecord, SourceComparison } from "./types.ts";

const databasePath = /(^|\/)(migrations?|schema|schema_migration|[^/]*_migration)(\/|\.|$)/i;
const databaseModelPath = /(^|\/)internal\/cluster\//i;
const workflowPath = /(^|\/)[^/]*workflow[^/]*(\/|$)/i;
const ignoredWorkflowArea = /(^|\/)(docs?|e2e|playground|test|tests|__tests__)(\/|$)/i;
const workflowCode = /(?:Cloudflare\.Workflows|WorkflowStep|workflowName|workflowStep|workflowRun|waitForEvent|\.task\s*\(|\.sleep\s*\()/i;
const nonRuntimePath = /(^|\/)(docs?|e2e|playground|test|tests|__tests__|marketing)(\/|$)|\.(?:md|mdx|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)$/i;
const runtimeRoot = /^(?:apps\/hosted\/|packages\/|lib\/)/;
const sourceExtension = /\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|sql|prisma|rs|java|kt|swift|c|cc|cpp|h|hpp)$/i;

export type PathState = "unchanged" | "changed" | "unknown";

// Carried-patch rules, derived from where the pinned upstream keeps its database and Workflow code:
// SQL migrations and schema modules, fumadb, PlanetScale roles and Hyperdrive in `database.ts`,
// Cloudflare Workflow classes, bindings and steps, and alchemy's `Cloudflare/Workflows` library.
// They judge a carry's touched paths and changed lines, so they may over-match but must not miss.
const carryDatabasePath = /(^|\/)[^/]*(?:migrat|schema|database|fumadb|planetscale|hyperdrive|postgres|pglite|sqlite|drizzle|prisma)[^/]*(\/|$)|(^|\/)sql(\/|\.[^/]+$)|(^|[/_.-])roles?([/_.-]|$)/i;
const carryDatabaseCode = [
  /migrat/i,
  /\b(?:create|alter|drop|truncate)\s+(?:(?:or\s+replace|unique|temp|temporary|unlogged|materialized|if\s+(?:not\s+)?exists|concurrently)\s+)*(?:table|index|schema|role|user|type|extension|trigger|function|procedure|view|sequence|policy|database|domain)\b/i,
  /\b(?:add|drop|alter|rename)\s+(?:column|constraint)\b/i,
  /\b(?:grant|revoke)\s+(?:all|select|insert|update|delete|usage|create|connect|execute|references|trigger|truncate|temp|temporary|maintain)\b/i,
  /\b(?:grant|revoke)\s+"?pg_\w+/i,
  /\b(?:primary\s+key|foreign\s+key|references\s+"?\w+"?\s*\()/i,
  /^\s*"?[a-z_][a-z0-9_]*"?\s+(?:text|integer|int|bigint|smallint|boolean|bool|timestamptz|timestamp|jsonb|json|uuid|varchar|bytea|numeric|serial|bigserial|real|date)\b\s*(?:,|$|\(\d|(?:not\s+null|null|primary|references|default|unique|check|generated)\b)/i,
  /\b(?:pg_roles|pg_authid|rolname|pg_read_all_data|pg_write_all_data|search_path|information_schema|pg_catalog|schema_migration|session\s+authorization|set\s+role)\b/i,
  /-c\s+role=/i,
  /\b(?:PostgresRole|inheritedRoles|planetscale|hyperdrive|DATABASE_URL|DatabaseUrl|fumadb)/i,
  /\b(?:idColumn|column|table)\s*\(\s*["'`]/,
  /\bschema\s*\(\s*\{/,
];
const carryWorkflowCode = [
  /workflow/i,
  /\bstep\.\w+\s*\(/,
  /waitForEvent|sleepUntil|NonRetryableError/,
  /\.task\s*\(/,
  /(?<!\bEffect)\.sleep\s*\(/,
];

/** A path no deployment executes: docs, tests, playgrounds, Markdown and static images. */
export function isInertPath(path: string): boolean {
  return nonRuntimePath.test(path);
}

export function isCarryDatabasePath(path: string): boolean {
  return isDatabasePath(path) || carryDatabasePath.test(path);
}

export function isCarryWorkflowPath(path: string): boolean {
  return workflowPath.test(path);
}

export function isCarryDatabaseCode(line: string): boolean {
  return carryDatabaseCode.some((rule) => rule.test(line));
}

export function isCarryWorkflowCode(line: string): boolean {
  return carryWorkflowCode.some((rule) => rule.test(line));
}

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
