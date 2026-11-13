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

export interface PoolReliability {
  readonly from: string;
  readonly to: string;
  readonly classification: "ready" | "pending";
  readonly real: ReliabilityCounts;
  readonly proof: ReliabilityCounts;
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
