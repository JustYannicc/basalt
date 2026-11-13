/** 0575 supplies forecasts; 0572 owns the observed-demand adapter and scheduling. */
export interface RoutingDemandInput {
  /** Opaque stable revision for correlation, never an account or customer identity. */
  readonly revision: string;
  readonly provider: string;
  /** Null means the evidence covers the provider's observed model mix, not a model-specific forecast. */
  readonly modelFamily: string | null;
  readonly calculatedAt: string;
  readonly validUntil: string;
  readonly source: "history-forecast" | "observed-quota-burn";
  readonly confidence: "low" | "medium" | "high";
  readonly history: {
    readonly from: string;
    readonly through: string;
    readonly coverageRatio: number;
    readonly censored: boolean;
    readonly heldOutPeriods: number;
    readonly relativeError: number | null;
  };
  /** Separate units for weekly and five-hour demand. Never add or convert them implicitly. */
  readonly windows: readonly {
    readonly seconds: 604800 | 18000;
    readonly mode: "fixed" | "rolling";
    readonly unit: { readonly id: string; readonly label: string; readonly revision: string };
    readonly calibration: "quota-observed" | "history-calibrated";
    readonly calibrationRevision: string;
    /** Non-overlapping UTC intervals in the window's work units, covering the supplied horizon. */
    readonly intervals: readonly {
      readonly from: string;
      readonly to: string;
      readonly demand: { readonly median: number; readonly upper80: number | null };
    }[];
    /** Full allowance, NOT remaining allowance. Selection always rereads fresh remaining quota. */
    readonly accounts: readonly {
      /** Current Home credential reference from trusted pool inventory. Never a CapacityHistory hash or public account ID. */
      readonly account: string;
      readonly full: number;
      readonly known: boolean;
      readonly plan: string | null;
      readonly weightRevision: string;
      /** Needed only to predict rolling-window releases; absent means do not invent replenishment. */
      readonly rollingReleases?: readonly { readonly at: string; readonly amount: number }[];
    }[];
    readonly candidatePlans: readonly {
      readonly plan: string;
      readonly full: number;
      readonly weightRevision: string;
      /** Refill cadence for a newly added account; advice must simulate it. */
      readonly resetEverySeconds: number;
    }[];
  }[];
}

export interface RoutingDemandAvailability {
  readonly status: "available" | "unavailable";
  readonly input: RoutingDemandInput | null;
  readonly reasons: readonly (
    | "quota-calibration-missing"
    | "insufficient-overlap"
    | "history-gap"
    | "partial-account-coverage"
    | "plan-weight-unknown"
    | "window-mode-unknown"
    | "rolling-release-history-missing"
    | "censored-demand"
    | "stale"
  )[];
}

export type RoutingDemandWindow = RoutingDemandInput["windows"][number];
