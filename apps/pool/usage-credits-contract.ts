/** Provider facts are shared; routing decisions belong to a specific pool. */
export type UsageCreditPolicy = "last_resort" | "never";
export type AccountSelectionPolicy = "reset_aware" | "balanced";
export interface UsageCredits {
  readonly state: "available" | "unlimited" | "none" | "disabled" | "unknown";
  readonly balance: {
    readonly value: string;
    readonly unit: "credits" | "currency";
    readonly currency?: string;
  } | null;
  readonly observedAt: string | null;
  readonly staleAt: string | null;
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly extraUsage: {
    readonly enabled: boolean | null;
    readonly monthlyCap: "limited" | "unlimited" | "unknown";
    readonly usedRatio: number | null;
    readonly spent: { readonly value: string; readonly currency: string } | null;
    readonly cap: { readonly value: string; readonly currency: string } | null;
  } | null;
}
export interface AccountUsageRouting {
  readonly use: "plan" | "credits" | "unknown" | "exhausted" | "blocked";
  readonly eligible: boolean;
  readonly reason:
    | "plan_available"
    | "credits_only"
    | "credits_disabled"
    | "credit_policy_never"
    | "usage_unknown"
    | "quota_exhausted"
    | "credential_unavailable"
    | "continuity_requires_reconnect";
  readonly policy: UsageCreditPolicy;
}
