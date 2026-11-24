import {
  historySeriesDiagnostics,
  historySeriesFailure,
  type HistorySeriesObservation,
} from "./series-diagnostics.ts";

export type HistoryReadAction =
  | "poolUsageSeries"
  | "poolUsageSummary"
  | "poolOverview"
  | "poolPersonalOverview"
  | "lastSuccessAt"
  | "poolUsageHistory";

/** Which part of the summary a statement belongs to; ordinals shift with the data, these don't. */
export type HistoryReadStep =
  | "begin"
  | "targets"
  | "coverage"
  | "daily"
  | "capture"
  | "hourly"
  | "incidents"
  | "commit"
  | "rollback"
  | "connect"
  /** The request history's page of rows, then the prices of that page. */
  | "page"
  | "prices";

/** The first Postgres code in the error or the causes it carries; never the message. */
function sqlstate(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** The read's own cause, or the one a database deadline error carries. */
function readFailure(error: unknown) {
  const failure = historySeriesFailure(error);
  return failure === "unknown" && error instanceof Error && error.cause !== undefined
    ? historySeriesFailure(error.cause)
    : failure;
}

/**
 * Watches one signed history read. A read with phases reports each statement as a
 * `history_<phases>_phase` line, labelled with the step the read marked. A read that answers 5xx
 * logs one `POOL_USAGE_READ_FAILED` line and reports once, so a failing overview alerts instead of
 * leaving a bare 503. The line names a statement only when the read's last statement failed: a
 * statement that failed inside a savepoint the read recovered from never takes the blame.
 * Built from closed fields only: never SQL, values or caller data.
 */
export function watchHistoryRead(
  action: HistoryReadAction,
  phases: "series" | "summary" | "requests" | undefined,
  now: () => number = () => performance.now(),
) {
  const started = now();
  let step: HistoryReadStep | undefined;
  let last: (HistorySeriesObservation & { step?: HistoryReadStep }) | undefined;
  const diagnostics = phases
    ? historySeriesDiagnostics((observation) => {
        const at = observation.phase === "database_connect" ? "connect" : step;
        const labelled = at === undefined ? observation : { ...observation, step: at };
        // A rollback after a failure is not the read's last word.
        if (observation.phase === "sql_statement" && step !== "rollback") last = labelled;
        if (observation.phase === "database_connect" && observation.status === "error")
          last = labelled;
        console.info(`history_${phases}_phase`, labelled);
      }, now)
    : undefined;
  return {
    diagnostics,
    /** Labels the statements that follow, until the next mark. */
    mark(next: HistoryReadStep) {
      step = next;
    },
    answered(error: unknown, response: Response, report?: (action: HistoryReadAction) => void) {
      if (response.status < 500) return;
      const failed = last?.status === "error" ? last : undefined;
      const code = sqlstate(error);
      try {
        console.error(
          "POOL_USAGE_READ_FAILED",
          JSON.stringify({
            action,
            status: response.status,
            failure: failed?.failure ?? readFailure(error),
            elapsedMs: Math.max(0, Math.min(60_000, Math.round(now() - started))),
            ...(code === undefined ? {} : { sqlstate: code }),
            ...(failed?.statement === undefined
              ? {}
              : { statement: failed.statement, statementMs: failed.elapsedMs }),
            ...(failed?.step === undefined ? {} : { step: failed.step }),
          }),
        );
        report?.(action);
      } catch {
        /* Reporting must not change the answer. */
      }
    },
  };
}
