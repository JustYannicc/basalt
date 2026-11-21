import { ControlFailure } from "../json.ts";
import { historyTimeoutReason, type HistoryTimeoutReason } from "./series-deadline.ts";

export type HistorySeriesPhase =
  | "signed_envelope_validation"
  | "account_labels"
  | "database_connect"
  | "sql_statement"
  | "price_callback"
  | "series_read"
  | "summary_read";
export type HistorySeriesFailure =
  | HistoryTimeoutReason
  | "unauthorized"
  | "invalid_input"
  | "database_error"
  | "transport"
  | "unknown";
export interface HistorySeriesObservation {
  phase: HistorySeriesPhase;
  status: "ok" | "error";
  elapsedMs: number;
  failure?: HistorySeriesFailure;
  statement?: number;
}
export interface HistorySeriesDiagnostics {
  run<T>(phase: HistorySeriesPhase, work: () => Promise<T>, statement?: number): Promise<T>;
}

export function historySeriesFailure(error: unknown): HistorySeriesFailure {
  const timeout = historyTimeoutReason(error);
  if (timeout) return timeout;
  if (error instanceof ControlFailure) {
    if (error.status === 401 || error.status === 403) return "unauthorized";
    if (error.status === 400) return "invalid_input";
  }
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return "database_error";
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE") return "transport";
  return "unknown";
}

/** Construct observations here so exceptions, SQL and caller values never reach the reporter. */
export function historySeriesDiagnostics(
  report: (observation: HistorySeriesObservation) => void = (observation) =>
    console.info("history_series_phase", observation),
  now: () => number = () => performance.now(),
): HistorySeriesDiagnostics {
  return {
    async run(phase, work, statement) {
      const started = now();
      let failure: HistorySeriesFailure | undefined;
      try {
        return await work();
      } catch (error) {
        failure = historySeriesFailure(error);
        throw error;
      } finally {
        try {
          report({
            phase,
            status: failure ? "error" : "ok",
            elapsedMs: Math.max(0, Math.min(60_000, Math.round(now() - started))),
            ...(failure ? { failure } : {}),
            ...(phase === "sql_statement" &&
            typeof statement === "number" &&
            Number.isSafeInteger(statement) &&
            statement > 0
              ? { statement }
              : {}),
          });
        } catch {
          /* Diagnostics must not change the response. */
        }
      }
    },
  };
}

export function historyPhase<T>(
  diagnostics: HistorySeriesDiagnostics | undefined,
  phase: HistorySeriesPhase,
  work: () => Promise<T>,
  statement?: number,
): Promise<T> {
  return diagnostics ? diagnostics.run(phase, work, statement) : work();
}
