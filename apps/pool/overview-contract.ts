import type { PoolUsageSeriesResult } from "./usage-series-contract.ts";
import type { PoolOverviewReliability } from "./reliability-contract.ts";

/** A member name supplied only after the hosted pool directory authorizes that member. */
export interface PoolOverviewMember {
  /** SHA-256 of the member id, matching the `person` key stored with model requests. */
  readonly person: string;
  readonly displayName: string;
  readonly active: boolean;
}

/** Signed host input: `active` means this person has current pool access. */
export interface PoolOverviewDirectoryInput {
  readonly members: readonly PoolOverviewMember[];
  readonly activeCount: number;
  readonly totalCount: number;
}

/** Public result: `active` means the person made at least one request in the selected range. */
export interface PoolOverviewDirectory {
  readonly members: readonly PoolOverviewMember[];
  readonly activeCount: number;
  readonly totalCount: number;
}

export interface OverviewPercentiles {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

export interface OverviewTokenPercentiles {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly percentiles: OverviewPercentiles | null;
  readonly requests: number;
  readonly excluded: { readonly missing: number; readonly unknownKind: number };
  readonly byPerson: readonly {
    readonly person: string;
    readonly p50: number | null;
    readonly p90: number | null;
    readonly p99: number | null;
    readonly requests: number;
  }[];
  readonly byModel: readonly {
    readonly provider: string;
    readonly model: string;
    readonly p50: number | null;
    readonly p90: number | null;
    readonly p99: number | null;
    readonly requests: number;
  }[];
  readonly byModelPerson: readonly {
    readonly person: string;
    readonly provider: string;
    readonly model: string;
    readonly p50: number | null;
    readonly p90: number | null;
    readonly p99: number | null;
    readonly requests: number;
  }[];
}

export interface OverviewMoneyMetric {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly amount: string | null;
  readonly currency: "USD";
  readonly pricedRequests: number;
  readonly excluded: {
    readonly unknownKind: number;
    readonly unknownKindValue: string | null;
    readonly unpriced: number;
  };
  readonly price: {
    readonly asOf: string;
    readonly source: string;
    readonly version: string;
  } | null;
}

export interface OverviewPerPersonDailyValue {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly p50: string | null;
  readonly p90: string | null;
  readonly currency: "USD";
  readonly activePeople: number;
  readonly completeDays: number;
}

/** Current public API rates from the pinned catalog preview, supplied by the trusted server only. */
export interface OverviewApiPrice {
  readonly provider: string;
  readonly model: string;
  readonly currency: "USD";
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly request: string;
  readonly tier: string | null | "*";
  readonly minInput: string;
  readonly asOf: string;
  readonly source: "models.dev";
  readonly version: string;
}

/** Trusted server diagnostics for a public rate lookup, separate from request accounting. */
export interface OverviewPriceIssue {
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
}

export interface OverviewPriceTable {
  readonly prices: readonly OverviewApiPrice[];
  readonly issues: readonly OverviewPriceIssue[];
}

export type OverviewOffering = "subscription" | "metered_api" | "prepaid" | "other" | "unknown";

/** This authority stays server-side in the signed native read. */
export interface PoolOverviewAuthority {
  readonly canManage: true;
  readonly accounts: readonly {
    readonly account: string | null;
    readonly history: readonly string[];
    readonly offering: OverviewOffering;
  }[];
  readonly mappingProven: boolean;
}

export interface OverviewFailurePercentile {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly p95: number | null;
  readonly unit: "percent";
  readonly hours: number;
}

export interface OverviewUsageSlice {
  readonly person: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly requests: number;
  readonly apiBilled: string | null;
  readonly apiPricedRequests: number;
  readonly apiUnpriced: number;
  readonly apiReason?: string;
  readonly subscriptionValue: string | null;
  readonly subscriptionPricedRequests: number;
  readonly subscriptionUnpriced: number;
  readonly subscriptionReason?: string;
  readonly unknownKind: number;
  readonly unknownKindValue: string | null;
  readonly price: {
    readonly asOf: string;
    readonly source: string;
    readonly version: string;
  } | null;
}

export interface PoolOverviewInput {
  readonly from: string;
  readonly to: string;
  readonly days: 7 | 30 | 90;
}

/** Added by the host after manager authorization. This is never accepted from the app browser. */
export interface PoolOverviewSignedInput extends PoolOverviewInput {
  readonly pool: string;
  readonly directory: PoolOverviewDirectoryInput;
  readonly authority: PoolOverviewAuthority;
}

/** The host derives this person hash from the signed-in caller, never from browser input. */
export interface PoolPersonalOverviewSignedInput extends PoolOverviewInput {
  readonly pool: string;
  readonly person: string;
  /** One entry per inspectable account-history reference; raw account ids and names stay on the host. */
  readonly offerings: readonly { readonly history: string; readonly offering: OverviewOffering }[];
}

/** Personal reads carry one person's series and percentiles, without a pool directory or totals. */
export interface PoolPersonalOverviewResult {
  readonly from: string;
  readonly to: string;
  /** The sole caller hash authorized by this read; it is never a member directory. */
  readonly person: string;
  readonly asOf: string | null;
  readonly consistency: "consistent" | "changed";
  readonly series: PoolUsageSeriesResult;
  readonly metrics: {
    readonly requestTokens: OverviewTokenPercentiles;
    /** API-equivalent USD estimate at current official prices, including subscription requests. Never Home credits. */
    readonly apiBilled: OverviewMoneyMetric;
    readonly subscriptionValue: OverviewMoneyMetric;
    readonly usageSlices: readonly OverviewUsageSlice[];
  };
  readonly partial: boolean;
}

export interface PoolOverviewResult {
  /** Absent in retained responses from servers predating explicit proof classification. */
  readonly reliability?: PoolOverviewReliability;
  readonly from: string;
  readonly to: string;
  readonly asOf: string | null;
  readonly consistency: "consistent" | "changed";
  /** Complete UTC Home request hours, verified against source IDs in the same read snapshot. */
  readonly homeCapture: {
    readonly capturedAt: string | null;
    readonly completeHours: readonly string[];
  };
  readonly directory: PoolOverviewDirectory;
  readonly people: PoolUsageSeriesResult;
  readonly models: PoolUsageSeriesResult;
  readonly requestsByHour: readonly {
    readonly provider: string;
    readonly at: string;
    readonly requests: number;
    /** Null until the source cursor can prove this hour was fully captured. */
    readonly coverage: number | null;
    readonly sourceAt: string | null;
  }[];
  readonly metrics: {
    readonly requestTokens: OverviewTokenPercentiles;
    /** API-equivalent USD estimate at current official prices, including subscription requests. Never Home credits. */
    readonly apiBilled: OverviewMoneyMetric;
    readonly subscriptionValue: OverviewMoneyMetric;
    readonly perActivePersonPerDay: OverviewPerPersonDailyValue;
    readonly failureShareWorstHourP95: OverviewFailurePercentile;
    readonly usageSlices: readonly OverviewUsageSlice[];
  };
  readonly partial: boolean;
}
