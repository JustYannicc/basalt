export type CapacityWeightSource = "reference-plan" | "published-session-multiplier" | "unknown-plan" | "reported-absolute";

export interface CapacityAggregate {
  readonly remaining: number;
  readonly full: number;
  /** Original sampler time for this complete cohort snapshot, not an inferred source time. */
  readonly at: number;
  /** Earliest and latest original observation timestamps among the readings that formed this total. */
  readonly observedAt: { readonly from: number; readonly to: number };
  /** Physical accounts in this provider/window/unit group at this snapshot. */
  readonly accountCount: number;
  readonly knownWeightCount: number;
  readonly unknownWeightCount: number;
  readonly weights: readonly { readonly source: CapacityWeightSource; readonly revision: string; readonly accountCount: number }[];
}

export interface CapacityPlanHistory {
  readonly plan: string | null;
  readonly minimum: CapacityAggregate;
  /** Null means this plan was absent from the latest complete snapshot in the hour. */
  readonly last: CapacityAggregate | null;
}

export interface CapacityHistoryPoint {
  readonly provider: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly unit: { readonly id: string; readonly label: string };
  /** UTC hour start. Empty hours are omitted, so missing observations remain gaps. */
  readonly hour: number;
  /** Lowest weighted remaining total in this hour, with its paired full total. */
  readonly minimum: CapacityAggregate;
  readonly last: CapacityAggregate;
  readonly plans: readonly CapacityPlanHistory[];
  /** Usable five-hour allowance, after excluding accounts whose weekly allowance is exhausted. */
  readonly usable?: CapacityAggregate | null;
  /** Joined from the hourly request series by the owner of that source, when available. */
  readonly requests?: number | null;
  readonly coverage?: number | null;
  readonly sourceAt?: number | null;
}

export interface CapacityForecastPoint {
  readonly at: number;
  readonly median: number;
  readonly low: number;
  readonly high: number;
  readonly busy: number;
  readonly usable?: number | null;
}

export interface CapacityShortfallStretch {
  readonly from: number;
  readonly to: number;
  readonly depth: number;
}

export interface CapacityForecastShortfall {
  readonly amount: number;
  readonly stretches: readonly CapacityShortfallStretch[];
  readonly candidate?: { readonly label: string; readonly capacity: number; readonly source: "reported" | "table" | "unit" } | null;
  readonly accounts: number | null;
  readonly exclusions: readonly string[];
  readonly accountBasis: "recurring-pattern" | "sustained-trend" | null;
}

export interface CapacityForecast {
  readonly provider: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly unit: { readonly id: string; readonly label: string };
  readonly status: "learning" | "estimated" | "unavailable";
  readonly reasons: readonly string[];
  readonly history: { readonly expectedHours: number; readonly observedHours: number; readonly coverage: number; readonly completedWeeks: number };
  readonly backtest: { readonly heldOutWeeks: number; readonly seasonalMae: number | null; readonly naiveMae: number | null; readonly beatsSeasonalNaive: boolean } | null;
  readonly residualCalibration: { readonly heldOutWeeks: number; readonly residualHours: number } | null;
  readonly classification: "normal" | "above" | "trend" | null;
  readonly streak: number;
  readonly recurringPeak: number | null;
  readonly points: readonly CapacityForecastPoint[];
  readonly runsOutAt: number | null;
  readonly busyRunsOutAt: number | null;
  readonly ordinary: CapacityForecastShortfall | null;
  readonly busy: CapacityForecastShortfall | null;
  readonly bankedAvailable: number | null;
}

export interface CapacityRefillEvent {
  readonly provider: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly unitId: string;
  readonly at: number;
  readonly amount: number;
  readonly amountIsLowerBound?: boolean;
  readonly kind: "observed" | "expected" | "banked";
}

export interface PoolCapacityHistory {
  readonly from: number;
  readonly to: number;
  readonly readAt: number | null;
  readonly trackingSince: number | null;
  readonly completedWeeks: number;
  readonly points: readonly CapacityHistoryPoint[];
  readonly forecasts: readonly CapacityForecast[];
  readonly refillEvents: readonly CapacityRefillEvent[];
  readonly estimate: { readonly status: "learning" | "estimated" | "unavailable"; readonly reason: string };
}
