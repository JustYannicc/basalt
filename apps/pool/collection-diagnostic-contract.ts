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

export interface XaiCollectionDiagnostic {
  readonly phase: (typeof xaiCollectionPhases)[number];
  readonly vendorCallStarted: boolean;
  readonly probeFinished: boolean;
  readonly snapshotWriteAttempted: boolean;
  readonly snapshotPersisted: boolean;
  readonly monthly: XaiResponseDiagnostic<(typeof xaiMonthlyFields)[number]>;
  readonly weekly: XaiResponseDiagnostic<(typeof xaiWeeklyFields)[number]>;
}

export interface CollectionDiagnostic {
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
