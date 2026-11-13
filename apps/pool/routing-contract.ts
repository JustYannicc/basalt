/** Pool routing contract. No provider credential, API-key, session-id, or request content. */
export type RoutingStrategy =
  | "quota-deadline"
  | "round-robin"
  | "fill-first"
  | "weighted-round-robin";

export interface RoutingSettings {
  readonly strategy: RoutingStrategy;
  /** Readback revision. The existing owner-only selection-policy write remains authoritative. */
  readonly revision: string;
  readonly changedAt: string;
  readonly canChange: boolean;
  readonly choices: readonly {
    readonly strategy: RoutingStrategy;
    readonly label: string;
    readonly description: string;
  }[];
}

export interface ForecastEvidence {
  readonly source: "history-forecast" | "observed-quota-burn" | "none";
  readonly status: "calibrated" | "observed" | "uncalibrated" | "stale" | "insufficient-history";
  readonly confidence: "low" | "medium" | "high" | null;
  readonly revision: string | null;
  readonly calculatedAt: string;
  readonly validUntil: string | null;
  readonly historyFrom: string | null;
  readonly historyThrough: string | null;
  readonly coverageRatio: number | null;
  readonly heldOutPeriods: number;
  readonly backtestRelativeError: number | null;
  /** Both demand and capacity must use this same evidenced work unit. Raw tokens are insufficient. */
  readonly unit: {
    readonly id: string;
    readonly label: string;
    readonly calibrationRevision: string;
  } | null;
  readonly reasons: readonly (
    | "quota-calibration-missing"
    | "plan-weight-unknown"
    | "quota-reading-stale"
    | "reset-unknown"
    | "rolling-window-history-missing"
    | "history-gap"
    | "demand-censored"
    | "sticky-demand-uncertain"
    | "forecast-expired"
  )[];
}

export interface CapacityOutlook {
  readonly provider: string;
  readonly modelFamily: string | null;
  readonly from: string;
  readonly through: string;
  /** True shortage is distinct from quota stranded by the configured strategy. */
  readonly status: "enough" | "routing-waste" | "needs-more-accounts" | "uncertain";
  readonly evidence: ForecastEvidence;
  readonly attention: CapacityAttention;
  readonly scenarios: readonly {
    readonly demand: "median" | "upper-80";
    readonly configuredUnserved: number;
    readonly feasibleUnserved: number;
    readonly expiringUnused: number;
    readonly firstShortfallAt: string | null;
    readonly bottleneck: "weekly" | "five-hour" | "concurrency" | "sticky" | "none";
  }[];
  /** Null means no defensible count. Zero is an actual estimated zero. */
  readonly recommendation: null | {
    readonly plan: string;
    readonly additionalAccounts: { readonly median: number; readonly upper80: number };
    readonly basis: "simulated-refill-schedule";
    readonly assumedNewAccountStart: string;
    readonly constraints: readonly string[];
  };
}

export type RoutingCandidate =
  | { readonly account: null; readonly display: "withheld" }
  | InspectableRoutingCandidate;

export interface InspectableRoutingCandidate {
  /** Existing public account identity, only when the caller may inspect it. Never a Home credential id. */
  readonly account: string;
  readonly display: "inspectable";
  readonly eligible: boolean;
  readonly funding: "plan" | "credits" | "unknown" | "blocked";
  readonly reason:
    | "target-share"
    | "balanced-fallback"
    | "affinity"
    | "parent-affinity"
    | "pinned"
    | "credits-last-resort"
    | "quota-exhausted"
    | "cooldown"
    | "concurrency-full"
    | "model-incompatible"
    | "disabled"
    | "no-target-spill"
    | "unavailable"
    | "existing-affinity"
    | "pinned-account";
  /** Account-wide deadline input. Model windows remain gates and never set this deadline. */
  readonly quota: null | {
    readonly remainingRatio: number;
    readonly window: "weekly" | "five-hour";
    readonly resetAt: string;
    readonly observedAt: string;
    readonly staleAt: string;
  };
  readonly fiveHour: null | {
    readonly remainingRatio: number;
    readonly resetAt: string | null;
    readonly mode: "fixed" | "rolling" | "unknown";
  };
  /** Work units per hour, null without a calibrated demand/capacity conversion. */
  readonly targetBurnRate: number | null;
  /** Server-computed from comparable remaining work and target burn, never ratio / work units. */
  readonly projectedEmptyAt: string | null;
  /** A refill ends the current budget; no exhaustion time is invented beyond that refill. */
  readonly emptyProjection: "estimated" | "not-before-reset" | "unavailable";
  /** Normalized share among eligible candidates at this decision; null for bypass/fallback. */
  readonly weight: number | null;
}

export interface RoutingDecision {
  readonly id: string;
  readonly at: string;
  readonly model: string;
  readonly configuredStrategy: RoutingStrategy;
  readonly effectiveStrategy: RoutingStrategy;
  readonly mode:
    | "forecast-paced"
    | "observed-paced"
    | "deadline-rate"
    | "balanced-fallback"
    | "configured-strategy"
    | "affinity"
    | "pinned"
    | "refused";
  readonly reason:
    | "deadline-budget"
    | "observed-burn-target"
    | "uncalibrated-demand"
    | "forecast-expired"
    | "unknown-rank"
    | "invalid-rank"
    | "expired-rank"
    | "credits-only"
    | "existing-affinity"
    | "parent-affinity"
    | "pinned-account"
    | "configured-strategy"
    | "no-eligible-account"
    | "mixed-provider-cohort";
  readonly forecast: ForecastEvidence | null;
  readonly targetThrough: string | null;
  readonly candidates: readonly RoutingCandidate[];
  readonly chosenAccount: string | null;
  readonly outcome: "admitted" | "refused";
  readonly attempts: readonly {
    readonly account: string | null;
    readonly outcome: "admitted" | "concurrency-full" | "unavailable";
  }[];
  /** Correlation to the pool's existing public usage record, if available. Never a wire session id. */
  readonly usageRecord: string | null;
}

/** Recomputed on read without picking an account or advancing SWRR credit. */
export interface RoutingNow {
  readonly provider: string;
  readonly modelFamily: string | null;
  /** Provider summaries evaluate account windows. A model-specific request still evaluates model gates. */
  readonly scope: "account-windows" | "model";
  readonly computedAt: string;
  readonly validUntil: string;
  readonly status: "available" | "unavailable";
  readonly configuredStrategy: RoutingStrategy;
  readonly effectiveStrategy: RoutingStrategy;
  readonly mode: RoutingDecision["mode"];
  readonly reason: RoutingDecision["reason"];
  readonly forecast: ForecastEvidence | null;
  readonly targetThrough: string | null;
  readonly candidates: readonly RoutingCandidate[];
}

/** Deterministic signal only. The editable owner-check workflow owns notification delivery. */
export interface CapacityAttention {
  readonly evaluatedAt: string;
  readonly notice: "none" | "needs-more-accounts" | "routing-waste";
  readonly inboxNudge: "none" | "eligible";
  /** One key per continuing provider/model/kind episode; clears with the shortage. */
  readonly episode: string | null;
  readonly firstShortfallAt: string | null;
  readonly reason:
    | "no-median-shortfall"
    | "outside-horizon"
    | "low-confidence"
    | "stale-evidence"
    | "incomplete-evidence"
    | "awaiting-confirmation"
    | "notice-only"
    | "within-three-days";
  readonly policy: {
    readonly minimumConfidence: "medium";
    readonly minimumCoverageRatio: 0.9;
    readonly minimumHeldOutPeriods: 2;
    readonly noticeHorizonDays: 7;
    readonly inboxHorizonDays: 3;
    /** A nudge needs two eligible observations at least five minutes apart. */
    readonly confirmationMinutes: 5;
  };
}

export interface RoutingDecisionsPage {
  readonly settings: RoutingSettings;
  readonly decisions: readonly RoutingDecision[];
  /** Current state remains meaningful when there has been no recent request. */
  readonly current: readonly RoutingNow[];
  readonly next: string | null;
  readonly retention: {
    readonly from: string;
    readonly through: string;
    readonly truncated: boolean;
    /** Decision history is bounded and resets on Home restart in the first release. */
    readonly persistence: "runtime";
  };
  /** The same forecast revision returned by the capacity endpoint, never recomputed in the UI. */
  readonly capacity: readonly CapacityOutlook[];
}
