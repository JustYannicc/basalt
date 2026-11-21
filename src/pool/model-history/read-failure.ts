import {
  historySeriesDiagnostics,
  historySeriesFailure,
  type HistorySeriesDiagnostics,
  type HistorySeriesObservation,
} from "./series-diagnostics.ts";

export type HistoryReadAction =
  | "poolUsageSeries"
  | "poolUsageSummary"
  | "poolOverview"
  | "poolPersonalOverview"
  | "lastSuccessAt";

/**
 * Watches one signed history read. A read with phases reports each statement as a
 * `history_<phases>_phase` line. A read that answers 5xx logs one `POOL_USAGE_READ_FAILED` line
 * naming the statement that failed and reports once, so a failing overview alerts instead of
 * leaving a bare 503. Built from closed fields only: never SQL, values or caller data.
 */
export function watchHistoryRead(
  action: HistoryReadAction,
  phases: "series" | "summary" | undefined,
  now: () => number = () => performance.now(),
) {
  const started = now();
  let failedStatement: HistorySeriesObservation | undefined;
  const diagnostics: HistorySeriesDiagnostics | undefined = phases
    ? historySeriesDiagnostics((observation) => {
        if (observation.status === "error" && observation.phase === "sql_statement")
          failedStatement ??= observation;
        console.info(`history_${phases}_phase`, observation);
      }, now)
    : undefined;
  return {
    diagnostics,
    answered(error: unknown, response: Response, report?: (action: HistoryReadAction) => void) {
      if (response.status < 500) return;
      try {
        console.error(
          "POOL_USAGE_READ_FAILED",
          JSON.stringify({
            action,
            status: response.status,
            failure: failedStatement?.failure ?? historySeriesFailure(error),
            elapsedMs: Math.max(0, Math.min(60_000, Math.round(now() - started))),
            ...(failedStatement?.statement === undefined
              ? {}
              : { statement: failedStatement.statement, statementMs: failedStatement.elapsedMs }),
          }),
        );
        report?.(action);
      } catch {
        /* Reporting must not change the answer. */
      }
    },
  };
}
