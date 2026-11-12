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
    | "classification_pending";
  readonly hour: PoolReliability;
  readonly day: PoolReliability;
}
