export const reliabilityNotificationMinimumRequests = 100;

export interface ReliabilityCounts {
  readonly requests: number;
  readonly failed: number;
  readonly unassignedFailures: number;
  /** Null means no requests, never a claim of 100% success. */
  readonly successRate: number | null;
  readonly failures: readonly {
    readonly status: number | null;
    readonly count: number;
    readonly unassigned: number;
  }[];
}

/** Requests whose outcome no record establishes. They count as possible failures. */
export interface UnknownOutcomes {
  /** Distinct requests; one in two classes counts once. */
  readonly requests: number;
  /** Started more than ten minutes ago with no finish. */
  readonly pending: number;
  /** Finished without an observable outcome. */
  readonly unavailable: number;
  /** A Home row with no finished start. */
  readonly unmatched: number;
  /** Not among the window's counted requests: no Home attempt of theirs is in the window. */
  readonly uncounted: number;
  /** Not already counted as failed, so their unknown outcome could still be a failure. */
  readonly couldFail: number;
}

export interface PoolReliability {
  readonly from: string;
  readonly to: string;
  readonly classification: "ready" | "pending";
  readonly real: ReliabilityCounts;
  readonly proof: ReliabilityCounts;
  /** Present on the objective's windows when terminal collection is ready. */
  readonly unknown?: UnknownOutcomes;
}

export interface PoolReliabilitySlo {
  readonly target: 99;
  readonly state: "ok" | "breached" | "no_traffic" | "unavailable";
  readonly captureAt: string | null;
  readonly reason?:
    | "history_inactive"
    | "capture_stale"
    | "capture_lagging"
    | "classification_pending"
    | "terminal_collection_unavailable"
    | "terminal_collection_pending";
  /** The latest five minutes, for an immediate failure signal alongside the hourly SLO. */
  readonly current?: PoolReliability;
  readonly hour: PoolReliability;
  readonly day: PoolReliability;
}

export type PoolOverviewReliability =
  | { readonly range: PoolReliability; readonly slo: PoolReliabilitySlo }
  | { readonly unavailable: true };
