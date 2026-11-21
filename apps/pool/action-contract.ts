import type { ResetMetadata, ResetScope } from "./reset-observation-contract.ts";

export type ResetWindow = "five_hour" | "seven_day" | "seven_day_overage_included";

export interface ResetCredit {
  readonly id: string;
  readonly type: "codex_rate_limits" | "cedar_ember";
  readonly remaining: number;
  readonly expiresAt: string | null;
  /** Null when the provider has not said whether an available credit can be used now. */
  readonly usableNow: boolean | null;
  readonly requiresLimit: boolean;
  /** Null for Codex, which decides which limited windows the reset clears. */
  readonly clears: readonly ResetWindow[] | null;
  /**
   * What the credit refills. Claude grants follow the rule the pool's Home applies to its reset
   * observations (CLIProxyAPI carry 0526); a Codex credit is the account's, since Codex picks which
   * of the account's limits it clears.
   */
  readonly kind: ResetMetadata["kind"];
  readonly scope: ResetScope;
}

/** The kind a person confirmed spending; a credit of any other kind is refused unspent. */
export interface ResetConfirmation {
  readonly kind: ResetMetadata["kind"];
  readonly scope: ResetScope;
}

export interface ResetCredits {
  readonly provider: "codex" | "claude";
  readonly observedAt: string;
  readonly available: number;
  readonly credits: readonly ResetCredit[];
}

export type ResetOutcome =
  | "reset"
  | "already_redeemed"
  | "already_used"
  | "nothing_to_reset"
  | "no_credit"
  | "not_limited"
  | "cooldown"
  | "ineligible"
  | "unavailable"
  | "rate_limited"
  | "auth_error"
  | "unknown";

export interface ResetResult {
  readonly requestId: string;
  readonly outcome: ResetOutcome;
  readonly cooldownCleared: boolean;
  readonly usageRefreshQueued: boolean;
}

/** The latest durable attempt; reading it never retries provider or follow-up work. */
export interface ResetAttempt extends ResetResult {
  readonly provider: "codex" | "claude";
  readonly creditId: string;
  readonly startedAt: string;
  /** The original provider idempotency window, including when its outcome remains unknown. */
  readonly retryUntil: string;
  readonly canRetryProvider: boolean;
}
