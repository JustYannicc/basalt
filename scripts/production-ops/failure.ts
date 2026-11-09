import {
  removalDiagnostic,
  type RemovalDiagnostic,
} from "../../src/pool/import-removal/failure.ts";

const categories = [
  "config",
  "auth",
  "decode",
  "sql",
  "encryption",
  "refused",
  "defect",
  "interrupted",
  "unknown",
  "home",
  "timeout",
] as const;
const causeKinds = ["failure", "defect", "interrupted", "composite"] as const;
const phases = [
  "config",
  "auth",
  "decode",
  "sql",
  "encryption",
  "forward",
  "request",
  "receipt",
  "readiness",
  "snapshot",
  "credential-delete",
  "membership-delete",
  "verify",
] as const;
const sqlClasses = [
  "08",
  "09",
  "0A",
  "0B",
  "0F",
  "0L",
  "0P",
  "0Z",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "2B",
  "2D",
  "2F",
  "34",
  "38",
  "39",
  "3B",
  "3D",
  "3F",
  "40",
  "42",
  "44",
  "53",
  "54",
  "55",
  "57",
  "58",
  "72",
  "F0",
  "HV",
  "P0",
  "XX",
] as const;

interface SourceRefusal {
  readonly code: string;
  readonly version: string;
  readonly expected: string;
  readonly actual: string;
}

const sourceRefusal = (value: unknown): SourceRefusal | undefined => {
  if (typeof value !== "object" || value === null) return;
  const row = value as Record<string, unknown>;
  if (
    typeof row.code !== "string" ||
    !/^code_[a-zA-Z0-9-]+$/u.test(row.code) ||
    typeof row.version !== "string" ||
    !/^dpl_[a-zA-Z0-9-]+$/u.test(row.version) ||
    typeof row.expected !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.expected) ||
    typeof row.actual !== "string" ||
    !(
      /^[a-f0-9]{64}$/u.test(row.actual) ||
      ["missing", "unreadable", "invalid"].includes(row.actual)
    )
  )
    return;
  return { code: row.code, version: row.version, expected: row.expected, actual: row.actual };
};

export interface FailureReceipt {
  readonly format: "basalt-production-ops-failure-v1";
  readonly category: (typeof categories)[number];
  readonly phase: (typeof phases)[number];
  readonly sqlStateClass?: (typeof sqlClasses)[number];
  readonly causeKind?: (typeof causeKinds)[number];
  readonly httpStatus?: number;
  readonly reason?: "operation_busy" | "organization_removing" | "stale_plan";
  readonly retryable?: boolean;
  readonly code?: RemovalDiagnostic["code"];
  readonly elapsedMs?: number;
  readonly rowId?: string;
  readonly homeStatus?: number;
  readonly homeCode?: RemovalDiagnostic["homeCode"];
  readonly source?: SourceRefusal;
}

export class OperationFailure extends Error {
  readonly receipt: FailureReceipt;
  constructor(receipt: FailureReceipt) {
    super("Production operation failed");
    this.receipt = receipt;
  }
}

/** Copy known fields only; the HTTP response and thrown message may contain credentials. */
export function failureReceipt(value: unknown): FailureReceipt | undefined {
  if (typeof value !== "object" || value === null) return;
  const row = value as Record<string, unknown>;
  const category = categories.find((entry) => entry === row.category);
  const phase = phases.find((entry) => entry === row.phase);
  if (row.format !== "basalt-production-ops-failure-v1" || !category || !phase) return;
  const reason =
    row.reason === "operation_busy" && row.retryable === true
      ? { reason: "operation_busy" as const, retryable: true }
      : row.reason === "organization_removing" && row.retryable === false
        ? { reason: "organization_removing" as const, retryable: false }
        : category === "refused" && row.reason === "stale_plan"
          ? { reason: "stale_plan" as const }
          : {};
  const sqlStateClass = sqlClasses.find((entry) => entry === row.sqlStateClass);
  const causeKind = causeKinds.find((entry) => entry === row.causeKind);
  const removal = removalDiagnostic(row);
  const source = category === "refused" ? sourceRefusal(row.source) : undefined;
  return {
    format: "basalt-production-ops-failure-v1",
    category,
    phase,
    ...(category === "sql" && sqlStateClass ? { sqlStateClass } : {}),
    ...(causeKind === undefined ? {} : { causeKind }),
    ...reason,
    ...removal,
    ...(source === undefined ? {} : { source }),
  };
}

export const failure = (
  category: FailureReceipt["category"],
  phase: FailureReceipt["phase"],
  httpStatus?: number,
): FailureReceipt => ({
  format: "basalt-production-ops-failure-v1",
  category,
  phase,
  ...(httpStatus === undefined ? {} : { httpStatus }),
});
