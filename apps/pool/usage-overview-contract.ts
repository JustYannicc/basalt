import type { OverviewMoneyMetric, OverviewUsageSlice } from "./overview-contract.ts";
import type { UsageForecasts } from "./usage-forecast-contract.ts";
import type {
  SeriesAuthority,
  SeriesBucket,
  SeriesCoverage,
  TokenSum,
} from "./usage-series-contract.ts";

export interface PoolUsageSummaryInput {
  readonly from: string;
  readonly to: string;
  readonly by?: "provider" | "model";
}

/** The host supplies inspection policy while holding the pool management lock. */
export interface PoolUsageSummarySignedInput extends PoolUsageSummaryInput {
  readonly pool: string;
  readonly authority: SeriesAuthority;
}

export interface UsageSummaryBucket {
  readonly at: string;
  readonly end: string;
  readonly partial: boolean;
  readonly requests: number;
  readonly failed: number;
  readonly limited: number;
  /** Counts-only native accounts never acquire token or price details in a rollup. */
  readonly details: null | {
    readonly tokens: SeriesBucket["tokens"];
    readonly apiEstimate: OverviewMoneyMetric;
  };
}

export interface UsageSummaryGroup {
  readonly provider: string | null;
  readonly model?: string | null;
  readonly countsOnly: boolean;
  readonly buckets: readonly UsageSummaryBucket[];
}

export interface UsageSummaryHeatmap {
  readonly from: string;
  readonly to: string;
  readonly basis: "recorded-usage";
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly cells: readonly {
    readonly provider: string | null;
    /** Monday is zero; hours use Europe/Zurich wall time. */
    readonly weekday: number;
    readonly hour: number;
    readonly requests: number;
    readonly tokens: TokenSum;
    readonly sampleHours: number;
  }[];
}

export interface UsageSummaryIncidents {
  readonly from: string;
  readonly to: string;
  readonly status: "available" | "partial" | "unavailable";
  readonly requests: number;
  readonly failed: number;
  readonly failures: readonly { readonly status: number | null; readonly count: number }[];
}

export interface PoolUsageSummaryResult {
  readonly from: string;
  readonly to: string;
  readonly timezone: "Europe/Zurich";
  /** Whole Zurich days compare calendar days; partial ranges compare the same elapsed duration. */
  readonly previous: { readonly from: string; readonly to: string };
  /** Coverage and forecasting share this broader history snapshot. */
  readonly readFrom: string;
  readonly asOf: string | null;
  readonly coverage: SeriesCoverage;
  /** Each day covers only its intersection with these bounds, including the current partial day. */
  readonly historyCoverage: {
    readonly from: string;
    readonly to: string;
    readonly knownDays: readonly string[];
    readonly gapDays: readonly string[];
  };
  readonly daily: readonly UsageSummaryGroup[];
  readonly previousDaily: readonly UsageSummaryGroup[];
  readonly models: null | {
    readonly status: "available" | "unavailable";
    readonly groups: readonly UsageSummaryGroup[];
    readonly reason?: string;
  };
  readonly forecasts: UsageForecasts;
  readonly usageSlices: readonly OverviewUsageSlice[];
  readonly usageSlicesUnavailableReason?: string;
  readonly heatmap: UsageSummaryHeatmap;
  readonly incidents: UsageSummaryIncidents;
  readonly homeCapture: {
    readonly status: "available" | "partial" | "unavailable";
    readonly reason?: string;
    readonly capturedAt: string | null;
    readonly completeHours: readonly string[];
  };
  readonly requestsByHour: readonly {
    readonly provider: string;
    readonly at: string;
    readonly requests: number;
    readonly coverage: number | null;
  }[];
  readonly partial: boolean;
}
