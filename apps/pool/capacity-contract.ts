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
}


export interface PoolCapacityHistory {
  readonly from: number;
  readonly to: number;
  readonly points: readonly CapacityHistoryPoint[];
  readonly estimate: { readonly status: "unavailable"; readonly reason: string };
}
