import type { OverviewMoneyMetric } from "./overview-contract.ts";
import type { UsageAccountDisplay } from "./usage-account-label-contract.ts";

export const seriesDimensions = [
  "account",
  "person",
  "model",
  "provider",
  "app",
  "attribution",
  "source",
] as const;
export type SeriesDimension = (typeof seriesDimensions)[number];
export interface PoolUsageSeriesInput {
  pool: string;
  from: string;
  to: string;
  bucket: "hour" | "day";
  by: readonly SeriesDimension[];
  accounts?: readonly string[];
  sources?: readonly string[];
  window?: { from: string; to: string };
  after?: string;
}

export interface SeriesAccount {
  /** A null saved ID is an account the caller cannot inspect. Never sent to a client. */
  account: string | null;
  history: readonly string[];
}
export interface SeriesAuthority {
  canManage: boolean;
  /** Trusted host capability. It stays false until the pinned live mapping fixture passes. */
  mappingProven: boolean;
  accounts: readonly SeriesAccount[];
}
export interface TokenSum {
  sum: string | null;
  known: number;
  missing: number;
}
export interface CostSum {
  amount: string | null;
  currency: string | null;
  priced: number;
  unpriced: number;
}
export interface Unavailable {
  status: "unavailable";
  reason: string;
}
export interface SeriesCounts {
  at: string;
  partial: boolean;
  requests: number;
  failed: number;
  unassignedFailures: number;
  successRate: number | null;
}
export interface SeriesBucket extends SeriesCounts {
  lastSuccessAtInRange: string | null;
  tokens: {
    input: TokenSum;
    output: TokenSum;
    cacheRead: TokenSum;
    cacheWrite: TokenSum;
    reasoning: TokenSum;
    total: TokenSum;
  };
  tokenQuality: { complete: number; legacy: number; unclassified: number; inconsistent: number };
  cost: {
    homeCharge: CostSum;
    importedApiPrice: CostSum;
    apiEquivalent: Unavailable;
    /** Current public USD estimate, separate from retained Home charges and historical prices. */
    apiEstimate?: OverviewMoneyMetric;
    unpricedRequests: number;
  };
  attribution: {
    chargeSnapshot: number;
    keyAtCapture: number;
    importOwner: number;
    unknown: number;
  };
}
export interface SeriesKey {
  currency: string | null;
  account?: string | null;
  person?: string | null;
  model?: string | null;
  provider?: string | null;
  app?: string | null;
  attribution?: string | null;
  source?: string | null;
}
export interface SeriesGroup {
  key: SeriesKey;
  accountDisplay?: UsageAccountDisplay;
  buckets: (SeriesBucket | SeriesCounts)[];
}
export interface SeriesCoverage {
  sources: {
    source: string;
    kind: "home" | "gateway" | "import";
    firstAt: string | null;
    lastAt: string | null;
    backfillComplete: boolean | null;
    sweep: { id: string; upper: string } | null;
  }[];
  firstAt: string | null;
  lastAt: string | null;
  capturedThrough: string | null;
  mapping: {
    current: true;
    historicalGenerations: "unknown";
    proof: "unavailable" | "proven";
    mapped: number;
    unmapped: number;
    otherAccounts: number;
  };
  pricing: {
    homeCharge: number;
    importedApiPrice: number;
    unpriced: number;
    missing: number;
    missingSnapshot: number;
    missingVersion: number;
    apiEquivalent: Unavailable;
  };
  priceProjection: Unavailable;
  percentiles: Unavailable;
  seasonalTrainingRange: Unavailable;
}
export interface PoolUsageSeriesResult {
  from: string;
  to: string;
  bucket: "hour" | "day";
  window?: { from: string; to: string };
  asOf: string | null;
  coverage: SeriesCoverage;
  groups: SeriesGroup[];
  next: string | null;
}

export const apiEquivalentUnavailable: Unavailable = {
  status: "unavailable",
  reason: "Retained Home valuations do not prove a USD provider API price.",
};
export const outsideSeries: Unavailable = {
  status: "unavailable",
  reason: "Outside the usage series contract.",
};
