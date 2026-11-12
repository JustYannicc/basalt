export interface QuotaFieldPresence {
  readonly present: boolean;
  readonly null: boolean;
  readonly quantityNull: boolean;
  readonly quantityValid: boolean;
  readonly fiveHour: boolean;
}

export const xaiMonthlyFields = [
  "config",
  "config.monthlyLimit",
  "config.monthly_limit",
  "config.used",
  "config.onDemandCap",
  "config.on_demand_cap",
  "config.onDemandUsed",
  "config.on_demand_used",
] as const;
export const xaiWeeklyFields = [
  "config",
  "config.creditUsagePercent",
  "config.credit_usage_percent",
  "config.currentPeriod",
  "config.current_period",
  "config.productUsage",
  "config.product_usage",
  "config.productUsage[].usagePercent",
  "config.productUsage[].usage_percent",
  "config.product_usage[].usagePercent",
  "config.product_usage[].usage_percent",
] as const;

export interface XaiFieldPresence {
  readonly present: boolean;
  readonly null: boolean;
  /** A finite parser-supported number; wildcard fields require every product's value. */
  readonly numeric: boolean;
}

export interface XaiResponseDiagnostic<Field extends string> {
  readonly responseReceived: boolean;
  readonly httpOk: boolean;
  readonly jsonValid: boolean;
  readonly fields: Readonly<Record<Field, XaiFieldPresence>>;
}

export const xaiCollectionPhases = [
  "claimed",
  "claim_failed",
  "claim_not_acquired",
  "failure_persisted",
  "snapshot_persisted",
  "snapshot_write_failed",
  "lease_lost",
] as const;

export const xaiEligibilityFailureReasons = [
  "malformed",
  "missing",
  "ambiguous",
  "non-string",
  "unknown-tier",
] as const;

export const xaiProfileFields = ["subscriptionTier", "subscription_tier"] as const;
export interface XaiProfileDiagnostic {
  readonly responseReceived: boolean;
  readonly httpOk: boolean;
  readonly jsonValid: boolean;
  readonly failureReason?: (typeof xaiEligibilityFailureReasons)[number];
  readonly fields: Readonly<
    Record<
      (typeof xaiProfileFields)[number],
      {
        readonly present: boolean;
        readonly null: boolean;
        readonly string: boolean;
      }
    >
  >;
}

export interface XaiCollectionDiagnostic {
  readonly profile?: XaiProfileDiagnostic;
  readonly phase: (typeof xaiCollectionPhases)[number];
  readonly vendorCallStarted: boolean;
  readonly probeFinished: boolean;
  readonly snapshotWriteAttempted: boolean;
  readonly snapshotPersisted: boolean;
  readonly monthly: XaiResponseDiagnostic<(typeof xaiMonthlyFields)[number]>;
  readonly weekly: XaiResponseDiagnostic<(typeof xaiWeeklyFields)[number]>;
}

export interface CollectionDiagnostic {
  readonly claude?: ClaudeQuotaShape;
  /** Home collector invocation time, separate from the SDK request and saved failure time. */
  readonly attemptedAt: string;
  readonly provider: "claude" | "codex" | "xai";
  readonly responseReceived: boolean;
  readonly jsonValid: boolean;
  readonly fiveHour?: QuotaFieldPresence;
  readonly primaryWindow?: QuotaFieldPresence;
  readonly secondaryWindow?: QuotaFieldPresence;
  readonly xai?: XaiCollectionDiagnostic;
}

/** Opt-in, closed discovery projection. No account, grant, or credential identifiers. */
export interface ClaudeQuotaShape {
  readonly limitsPresent: boolean;
  readonly grantsPresent: boolean;
  readonly truncated: boolean;
  readonly limits: readonly {
    readonly kind: string;
    readonly model?: string;
    readonly percent?: number;
    readonly resetsAt?: string;
  }[];
  readonly grants: readonly {
    readonly type?: string;
    readonly remaining?: number;
    readonly clears: readonly string[];
    readonly givesBackWeekly: boolean;
    readonly startsAt?: string;
    readonly endsAt?: string;
    readonly paused: boolean;
  }[];
}

export const collectionRequestDispositions = [
  "cached_fresh",
  "unlimited",
  "home_backoff",
  "pool_cap",
  "submitted",
  "home_already_queued",
  "home_completed",
  "home_pending",
  "submission_unconfirmed",
  "read_failed",
] as const;

export interface CollectionRequest {
  readonly requestedAt: string;
  readonly disposition: (typeof collectionRequestDispositions)[number];
  readonly homeAttemptAt?: string;
  readonly nextAllowedAt?: string;
  readonly accepted?: boolean;
}
