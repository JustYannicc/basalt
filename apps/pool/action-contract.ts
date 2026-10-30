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
}

export interface ResetCredits {
  readonly provider: "codex" | "claude";
  readonly observedAt: string;
  readonly available: number;
  readonly credits: readonly ResetCredit[];
}

export type ResetOutcome = "reset" | "already_redeemed" | "already_used" | "nothing_to_reset" | "no_credit"
  | "not_limited" | "cooldown" | "ineligible" | "unavailable" | "rate_limited" | "auth_error" | "unknown";

export interface ResetResult {
  readonly requestId: string;
  readonly outcome: ResetOutcome;
  readonly cooldownCleared: boolean;
  readonly usageRefreshQueued: boolean;
}
