export interface UsageDay {
  readonly day: string;
  readonly value: number | null;
  readonly requests: number;
}

export interface UsageProjection {
  readonly from: string;
  readonly through: string;
  readonly actual: number | null;
  readonly median: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

export interface UsageMiss {
  readonly week: string;
  readonly predicted: number;
  readonly actual: number;
  readonly error: number;
  readonly share: number | null;
}

export type UsageForecast =
  | {
      readonly status: "unavailable";
      readonly reason: "invalid-input" | "insufficient-history" | "insufficient-use";
      readonly comparableWeeks: number;
      readonly calculatedAt: string;
    }
  | {
      readonly status: "available";
      readonly calculatedAt: string;
      readonly timezone: "Europe/Zurich";
      readonly method: "Median of the last 4 full weeks, shaped by day of week";
      readonly confidence: "Low" | "Medium" | "High";
      readonly coverage: {
        readonly basis: "recorded-total" | "known-subset";
        /** Missing values across the supplied history, including held-out weeks. */
        readonly excludedRequests: number;
      };
      readonly interval: 0.8;
      readonly comparableWeeks: number;
      readonly trainingWeeks: readonly string[];
      readonly misses: readonly UsageMiss[];
      readonly thisWeek: UsageProjection;
      readonly nextWeek: UsageProjection;
      readonly month: UsageProjection;
      /** Remaining use today; full forecast days thereafter. */
      readonly daily: readonly {
        readonly day: string;
        readonly median: number;
        readonly low: number | null;
        readonly high: number | null;
      }[];
    };

export interface UsageForecasts {
  readonly calculatedAt: string;
  readonly timezone: "Europe/Zurich";
  readonly basis: "recorded-usage";
  readonly warnings: readonly string[];
  readonly series: readonly {
    readonly provider: string | null;
    readonly requests: UsageForecast;
    readonly tokens: UsageForecast;
    readonly apiEstimate: UsageForecast;
    readonly excluded: { readonly tokens: number; readonly apiEstimate: number };
  }[];
}
