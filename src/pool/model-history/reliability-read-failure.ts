import type { HistoryDatabase } from "./schema.ts";
import { historyTimeoutReason } from "./series-deadline.ts";

// Closed labels for the reliability read's statements, so a failure names its step without SQL text.
const steps: readonly (readonly [string, string])[] = [
  ["BEGIN", "begin"],
  ["statement_timeout", "timeout_setting"],
  ["to_regclass", "readiness"],
  ["FROM basalt_model_history_migrations WHERE name", "readiness"],
  ["FROM selected", "windows"],
  ["FROM basalt_model_history_cursor", "cursor"],
  ["FROM usage", "lagging"],
  ["AS pending", "terminal_pending"],
  ["AS unmatched_home", "terminal_evidence"],
  ["COMMIT", "commit"],
  ["ROLLBACK", "rollback"],
];

export function reliabilityStep(text: string): string {
  return steps.find(([fragment]) => text.includes(fragment))?.[1] ?? "other";
}

/** A timeout reason, an SQLSTATE class or a closed session cause. Never a driver message. */
export function reliabilityFailure(error: unknown): {
  failure: string;
  sqlstate?: string;
} {
  const timeout = historyTimeoutReason(error);
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  if (timeout) return { failure: timeout, ...(sqlstate ? { sqlstate } : {}) };
  if (sqlstate) return { failure: "sql_error", sqlstate };
  if (error instanceof Error) {
    if (error.message === "Model request history is disabled")
      return { failure: "history_disabled" };
    if (error.message === "Model history database is unavailable")
      return { failure: "database_unavailable" };
    if (error.message === "Model history database deadline exceeded")
      return { failure: "total_deadline" };
  }
  return { failure: "unknown" };
}

/** The read rethrows unchanged; the log names the step that failed and why. */
export function reportingReliabilityStatements(db: HistoryDatabase): HistoryDatabase {
  return {
    query: async (text, values) => {
      try {
        return await db.query(text, values);
      } catch (error) {
        const step = reliabilityStep(text);
        // A rollback after a failure only repeats the cause already reported.
        if (step !== "rollback")
          console.error("POOL_REQUEST_RELIABILITY_READ_FAILED", {
            step,
            ...reliabilityFailure(error),
          });
        throw error;
      }
    },
  };
}
