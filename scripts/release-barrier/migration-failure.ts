import { readFileSync } from "node:fs";
import { parseProductMigrationMarkers } from "./sql-schema-expectations.ts";

const phases = [
  "open the database sessions",
  "prepare the migration session",
  "take the migration lock",
  "check the executor storage version",
  "plan the auth schema",
  "apply the auth schema",
  "migrate the executor tables",
  "run the hosted product steps",
  "run the cloud product steps",
  "build the executor indexes",
  "provision the OAuth resources",
  "close the database sessions",
];
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** Registry names come from this candidate's literal migration definitions, never command output. */
function registeredPhases() {
  const result = new Map<string, { registry: "hosted" | "cloud"; migration: string }>();
  for (const registry of ["hosted", "cloud"] as const) {
    try {
      const path =
        registry === "hosted"
          ? "../../.upstream/apps/hosted/server/src/implementation/migrations.ts"
          : "../../.upstream/apps/hosted/cloud/src/implementation/migrations.ts";
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      for (const migration of parseProductMigrationMarkers(
        source,
        `private_${registry}_migrations`,
      ))
        result.set(`run ${registry} migration ${migration}`, { registry, migration });
    } catch {
      // Diagnostics cannot replace the original command failure if source metadata is unavailable.
    }
  }
  return result;
}

export type MigrationDiagnostic = {
  phase: string;
  registry?: "hosted" | "cloud";
  migration?: string;
  version?: string;
  sqlState?: string;
  message: string;
};

const sqlStatePattern =
  /(?:\bSQLSTATE |\()(?:([0-5][0-9A-Z][0-9A-Z]{3}|F0[0-9A-Z]{3}|HV[0-9A-Z]{3}|P0[0-9A-Z]{3}|XX[0-9A-Z]{3}))\b/;
const versionPattern = /\bat executor version (\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

function diagnostic(stderr: string): MigrationDiagnostic {
  const registered = registeredPhases();
  let current: Omit<MigrationDiagnostic, "message"> = { phase: "unknown" };
  // Only fixed producer lines are interpreted. Driver text, SQL, blockers and identifiers stay out.
  for (const line of stderr.slice(-65_536).split(/\r?\n/).slice(-256)) {
    if (line.length > 1024) continue;
    const step = /^Migration step \(attempt [12]\): (.+)$/.exec(line);
    const failed =
      /^(?:Cloud migration failed at "([^"]+)" \(attempt [12] of 2\)|Migration step failed at "([^"]+)"): (.+)$/.exec(
        line,
      );
    const phase = step?.[1] ?? failed?.[1] ?? failed?.[2];
    if (phase === undefined) continue;
    const entry = registered.get(phase);
    const known = entry !== undefined || phases.includes(phase);
    if (!known) {
      current = { phase: "unknown" };
      continue;
    }
    if (step || current.phase !== phase) current = { phase, ...entry };
    if (!failed) continue;
    const description = failed[3]!;
    const state = sqlStatePattern.exec(description)?.[1];
    const version = versionPattern.exec(description)?.[1];
    if (state) current.sqlState = state;
    if (version) current.version = version;
  }
  const category =
    current.sqlState === "55P03"
      ? "lock timeout"
      : current.sqlState === "57014"
        ? "statement timeout or cancel"
        : current.sqlState
          ? "database error"
          : "details unavailable";
  return {
    ...current,
    message:
      `Migration failed: ${category}${current.sqlState ? `; SQLSTATE ${current.sqlState}` : ""}`.slice(
        0,
        240,
      ),
  };
}

/** Recognize only the admitted migration command; never copy command, environment or stderr. */
export function migrationCommandFailure(error: unknown) {
  if (field(error, "_tag") !== "CommandError" || field(error, "command") !== "node src/migrate.ts")
    return undefined;
  const reason = field(error, "reason");
  const tag = field(reason, "_tag");
  if (
    tag !== "UnexpectedExit" &&
    tag !== "CommandTimedOut" &&
    tag !== "SystemError" &&
    tag !== "BadArgument"
  )
    return undefined;
  const code = field(reason, "exitCode");
  const stderr = field(reason, "stderr");
  return {
    type: "CommandError",
    reason: tag,
    exitCode:
      typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 255
        ? code
        : null,
    migration: diagnostic(typeof stderr === "string" ? stderr : ""),
  };
}
