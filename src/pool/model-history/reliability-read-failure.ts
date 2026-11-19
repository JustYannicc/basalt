import type { HistoryDatabase } from "./schema.ts";
import { historySeriesFailure, type HistorySeriesFailure } from "./series-diagnostics.ts";

// Each statement of the reliability read, by a fragment only that statement contains. A failure
// names its step this way, so neither SQL text nor parameters reach the log.
const statements = [
  ["BEGIN", "begin"],
  ["statement_timeout", "timeout_setting"],
  ["to_regclass('basalt_model_terminal_starts')", "terminal_tables"],
  ["FROM basalt_model_history_migrations WHERE name", "terminal_marker"],
  ["to_regclass('basalt_model_traffic')", "traffic_table"],
  ["FROM selected", "windows"],
  ["FROM basalt_model_history_cursor", "cursor"],
  ["to_regclass('usage')", "usage_table"],
  ["FROM usage WHERE", "lagging"],
  ["unknown(class,id,at)", "unknown_outcomes"],
  ["COMMIT", "commit"],
  ["ROLLBACK", "rollback"],
] as const;

export type ReliabilityStep = (typeof statements)[number][1] | "other" | "session";
export type ReliabilityFailure =
  | HistorySeriesFailure
  | "history_disabled"
  | "database_unavailable"
  | "history_deadline"
  | "probe_budget";

export function reliabilityStep(text: string): ReliabilityStep {
  return statements.find(([fragment]) => text.includes(fragment))?.[1] ?? "other";
}

/** A closed failure and, for a database error, its five-character SQLSTATE. Never a driver message. */
export function reliabilityFailure(error: unknown): {
  failure: ReliabilityFailure;
  sqlstate?: string;
} {
  if (error instanceof Error) {
    if (error.message === "Model request history is disabled")
      return { failure: "history_disabled" };
    if (error.message === "Model history database is unavailable")
      return { failure: "database_unavailable" };
    // The session rethrows every timeout, of any kind, as this one message.
    if (error.message === "Model history database deadline exceeded")
      return { failure: "history_deadline" };
  }
  const failure = historySeriesFailure(error);
  // Only a server error carries an SQLSTATE; a socket code such as EPIPE has the same shape.
  const database = typeof error === "object" && error !== null && "severity" in error;
  const code = database && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? { failure, sqlstate: code }
    : { failure };
}

/** The read rethrows unchanged; the log names the step that failed and why. */
export function reportingReliabilityStatements(
  db: HistoryDatabase,
  read: "standalone" | "overview",
): HistoryDatabase {
  return {
    query: async (text, values) => {
      try {
        return await db.query(text, values);
      } catch (error) {
        const step = reliabilityStep(text);
        // A rollback after a failure only repeats the cause already reported.
        if (step !== "rollback")
          console.error("POOL_REQUEST_RELIABILITY_READ_FAILED", {
            read,
            step,
            ...reliabilityFailure(error),
          });
        throw error;
      }
    },
  };
}
