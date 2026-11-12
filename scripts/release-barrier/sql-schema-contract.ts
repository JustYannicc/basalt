import type { HomeMigrationReceipt } from "./home-schema-operation.ts";
import { BarrierRefusal, type PlanRefusal } from "./refusal.ts";

export const sqlSchemaNamespaces = [
  "hosted",
  "cloud",
  "sdk",
  "registry",
  "model-history",
  "home",
] as const;
export type SqlSchemaNamespace = (typeof sqlSchemaNamespaces)[number];
export type SqlDatabase = "tools" | "pool";

export interface SqlSchemaExpectation {
  namespace: SqlSchemaNamespace;
  database: SqlDatabase;
  journal: string;
  kind: "markers" | "version" | "home";
  expected: readonly string[];
  registered?: readonly string[];
}

export interface SqlSchemaObservation {
  namespace: SqlSchemaNamespace;
  database: SqlDatabase;
  journal: string;
  expected: readonly string[];
  applied: readonly string[] | null;
  pending: readonly string[] | null;
  unexpected: readonly string[] | null;
  status: "ready" | "pending" | "incompatible" | "unreadable";
  observedAt: string;
  reason?:
    | "connection"
    | "journal-missing"
    | "journal-type"
    | "identity"
    | "query"
    | "invalid-marker";
  sqlState?: string;
}

/** Schema journals only. Historical data-maintenance journals have separate authority. */
export interface HomeSchemaProof {
  imageDigest: string;
  targetVersion: number;
  expectedIndexes: readonly string[];
  readyIndexes: readonly string[] | null;
  pendingIndexes: readonly string[] | null;
  status: "ready" | "pending" | "incompatible" | "unreadable";
  observedAt: string;
}

export interface SqlSchemaReceipt {
  formatVersion: 1;
  candidate: string;
  homeImageDigest: string;
  scope: "six-schema-namespaces";
  observations: readonly SqlSchemaObservation[];
  home?: HomeSchemaProof;
  homeMigration?: HomeMigrationReceipt;
}

export function validateSqlExpectations(expectations: readonly SqlSchemaExpectation[]) {
  const names = expectations.map((entry) => entry.namespace);
  if (
    expectations.length !== sqlSchemaNamespaces.length ||
    new Set(names).size !== sqlSchemaNamespaces.length ||
    sqlSchemaNamespaces.some((name) => !names.includes(name)) ||
    expectations.some(
      (entry) =>
        !entry.expected.length ||
        new Set(entry.expected).size !== entry.expected.length ||
        entry.expected.some((version) => !/^[a-zA-Z0-9_.-]{1,160}$/.test(version)) ||
        (entry.kind !== "markers" && entry.expected.length !== 1) ||
        (entry.registered !== undefined &&
          (!entry.registered.length ||
            new Set(entry.registered).size !== entry.registered.length ||
            entry.registered.some((version) => !/^[a-zA-Z0-9_.-]{1,160}$/.test(version)) ||
            entry.registered.at(-1) !== entry.expected[0])),
    )
  )
    throw new BarrierRefusal("sql-schema-expectations-invalid");
}

export function unreadableSqlSchema(
  expectation: SqlSchemaExpectation,
  reason: SqlSchemaObservation["reason"],
  error?: unknown,
): SqlSchemaObservation {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return {
    namespace: expectation.namespace,
    database: expectation.database,
    journal: expectation.journal,
    expected: [...expectation.expected],
    applied: null,
    pending: null,
    unexpected: null,
    status: "unreadable",
    observedAt: new Date().toISOString(),
    reason,
    ...(/^[A-Z0-9]{5}$/.test(code) ? { sqlState: code } : {}),
  };
}

export function observeSqlVersions(
  expectation: SqlSchemaExpectation,
  applied: string[],
): SqlSchemaObservation {
  if (
    new Set(applied).size !== applied.length ||
    applied.some((version) => !/^[a-zA-Z0-9_.-]{1,160}$/.test(version)) ||
    (expectation.kind !== "markers" && applied.length > 1)
  )
    return unreadableSqlSchema(expectation, "invalid-marker");
  let pending: string[];
  let unexpected: readonly string[];
  if (expectation.kind === "markers") {
    pending = expectation.expected.filter((version) => !applied.includes(version));
    unexpected = applied.filter((version) => !expectation.expected.includes(version));
  } else {
    const current = applied[0];
    const target = expectation.expected[0]!;
    const registered = expectation.registered ?? [target];
    const index = current === undefined ? -1 : registered.indexOf(current);
    const homeOlder =
      expectation.kind === "home" &&
      current !== undefined &&
      /^\d+$/.test(current) &&
      Number(current) < Number(target);
    unexpected = current !== undefined && index === -1 && !homeOlder ? [current] : [];
    pending =
      current === target
        ? []
        : index >= 0
          ? registered.slice(index + 1)
          : [...expectation.expected];
  }
  return {
    namespace: expectation.namespace,
    database: expectation.database,
    journal: expectation.journal,
    expected: [...expectation.expected],
    applied: [...applied],
    pending,
    unexpected,
    status: unexpected.length ? "incompatible" : pending.length ? "pending" : "ready",
    observedAt: new Date().toISOString(),
  };
}

export function assertSqlSchemas(receipt: SqlSchemaReceipt, candidate: string) {
  const entries = receipt.observations;
  const names = entries.map((entry) => entry.namespace);
  if (
    receipt.formatVersion !== 1 ||
    receipt.scope !== "six-schema-namespaces" ||
    receipt.candidate !== candidate ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.homeImageDigest) ||
    entries.length !== sqlSchemaNamespaces.length ||
    new Set(names).size !== sqlSchemaNamespaces.length ||
    sqlSchemaNamespaces.some((name) => !names.includes(name))
  )
    throw new BarrierRefusal("sql-schema-receipt-incomplete");
  const blocked = entries.filter(
    (entry) =>
      entry.status !== "ready" ||
      entry.pending === null ||
      entry.pending.length !== 0 ||
      entry.unexpected === null ||
      entry.unexpected.length !== 0 ||
      entry.applied === null ||
      entry.applied.length !== entry.expected.length ||
      new Set(entry.applied).size !== entry.applied.length ||
      entry.expected.some((version) => !entry.applied!.includes(version)),
  );
  const home = receipt.home;
  const homeEntry = entries.find((entry) => entry.namespace === "home")!;
  const validOperation =
    receipt.homeMigration === undefined ||
    ["skipped", "migrated", "noop"].includes(receipt.homeMigration.state);
  const validHome =
    validOperation &&
    home !== undefined &&
    home.imageDigest === receipt.homeImageDigest &&
    String(home.targetVersion) === homeEntry.expected[0] &&
    home.status === "ready" &&
    home.pendingIndexes !== null &&
    home.pendingIndexes.length === 0 &&
    home.readyIndexes !== null &&
    home.readyIndexes.length === home.expectedIndexes.length &&
    new Set(home.readyIndexes).size === home.readyIndexes.length &&
    home.expectedIndexes.every((name) => home.readyIndexes!.includes(name));
  if (!validHome && !blocked.includes(homeEntry)) blocked.push(homeEntry);
  if (!blocked.length) return;
  const details = blocked.map(
    (entry) =>
      `${entry.namespace}: required=${entry.expected.join(",")} applied=${entry.applied?.join(",") ?? "unknown"} pending=${entry.pending?.join(",") ?? "unknown"}${entry.unexpected?.length ? ` unexpected=${entry.unexpected.join(",")}` : ""}${entry.reason ? ` reason=${entry.reason}` : ""}${entry.sqlState ? ` SQLSTATE=${entry.sqlState}` : ""}${entry.namespace === "home" && !validHome ? ` native-indexes=${home?.pendingIndexes?.join(",") ?? "unknown"} readiness=${home?.status ?? "unreadable"}${receipt.homeMigration ? ` migration=${receipt.homeMigration.state} cause=${receipt.homeMigration.reason ?? "none"}${receipt.homeMigration.priorIntentId ? ` prior-intent=${receipt.homeMigration.priorIntentId}` : ""}` : ""}` : ""}`,
  );
  const refusals: PlanRefusal[] = blocked.map((entry) => ({
    reason: "sql-schema-not-ready",
    fqn: `SQL.${entry.namespace}`,
    type: "PostgreSQL schema",
    changed: [
      { path: "version", old: entry.applied?.join(",") ?? null, new: entry.expected.join(",") },
    ],
    why: [details[blocked.indexOf(entry)]!],
  }));
  throw new BarrierRefusal("sql-schema-not-ready", details.join("; "), undefined, refusals);
}
