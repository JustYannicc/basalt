export interface ResetScope {
  readonly kind: "account" | "model" | "unknown";
  readonly id?: string;
}

export interface ResetMetadata {
  readonly kind: "session" | "weekly" | "full" | "model" | "unknown";
  /** The provider's window identifiers. A model reset can also refill a session. */
  readonly clears?: readonly string[];
  /** Returns only this model's use on the shared weekly allowance. */
  readonly givesBackWeekly?: boolean;
}

export interface BankedResetGroup {
  readonly label: string;
  readonly available: number;
  readonly expiresAt: string | null;
  readonly scope: ResetScope;
  readonly reset: ResetMetadata;
}
