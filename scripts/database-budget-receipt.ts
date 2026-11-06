import type { RuntimeReady } from "../src/pool/deployment-readiness.ts";

export type BudgetStage = "readiness" | "connect" | "read" | "converge" | "teardown";
export interface BackendCount {
  database: string;
  connections: number;
}
export type BudgetOutcome =
  | "converged"
  | "over-budget-deadline"
  | "readiness-error"
  | "connect-error"
  | "sql-error"
  | "statement-timeout"
  | "abort"
  | "invalid-observation"
  | "incomplete-visibility"
  | "teardown-error";
export interface BudgetReceipt {
  candidate: string;
  target?: Pick<RuntimeReady, "candidate" | "workerInput" | "imageHash">;
  operationStartedAt?: number;
  overallDeadlineMs?: number;
  commandDeadlineMs?: number;
  outcome: BudgetOutcome;
  stage: BudgetStage;
  elapsedMs: number;
  deadlineMs: number;
  successfulSamples: number;
  lastSampleAt: number | null;
  counts: BackendCount[] | null;
  runtime: RuntimeReady | null;
  sampleRuntime: RuntimeReady | null;
  code?: string;
}
export class DatabaseBudgetFailure extends Error {
  readonly receipt: BudgetReceipt;
  constructor(receipt: BudgetReceipt) {
    super(
      `Database backend verification ${receipt.outcome}${receipt.outcome === "over-budget-deadline" ? " (did not converge)" : ""}: ${JSON.stringify(receipt)}`,
    );
    this.receipt = receipt;
  }
}
const sqlStates = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "28000",
  "28P01",
  "42501",
  "42601",
  "42P01",
  "42703",
  "53300",
  "53400",
  "54000",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "58000",
  "58030",
  "XX000",
]);
const driverCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "ABORT_ERR",
]);
export function safeDatabaseError(
  error: unknown,
  stage: BudgetStage,
): { outcome: BudgetOutcome; code?: string } {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const safeCode = code && (sqlStates.has(code) || driverCodes.has(code)) ? code : undefined;
  const name = error instanceof Error ? error.name : "";
  return {
    outcome:
      name === "AbortError" || safeCode === "ABORT_ERR"
        ? "abort"
        : safeCode === "57014" || (error instanceof Error && error.message === "Query read timeout")
          ? "statement-timeout"
          : stage === "readiness"
            ? "readiness-error"
            : stage === "connect"
              ? "connect-error"
              : "sql-error",
    ...(safeCode ? { code: safeCode } : {}),
  };
}
