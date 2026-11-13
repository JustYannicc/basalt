import { capacityOutlook } from "./routing-outlook-view.ts";
import type {
  RoutingCandidate,
  RoutingDecision,
  RoutingDecisionsPage,
  RoutingSettings,
  RoutingStrategy,
  RoutingNow,
} from "../../apps/pool/routing-contract.ts";
import { object, rows, unavailable, type Json } from "./json.ts";

const instant = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return unavailable();
  return new Date(at).toISOString();
};
const bounded = (value: unknown, maximum = 256) => {
  if (typeof value !== "string" || !value || value.length > maximum || /\p{Cc}/u.test(value))
    return unavailable();
  return value;
};
const finite = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return unavailable();
  return value;
};
const ratio = (value: unknown) => {
  const number = finite(value);
  return number <= 1 ? number : unavailable();
};
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const choice = <const T extends string>(value: unknown, values: readonly T[]): T =>
  values.find((item) => item === value) ?? unavailable();

export const strategyForPolicy = (policy: string): RoutingStrategy =>
  policy === "reset_aware"
    ? "quota-deadline"
    : policy === "balanced"
      ? "round-robin"
      : unavailable();

/** Preserve the current picker. New choices become public only with their approved UI. */
export function routingSettings(
  policy: string,
  changedAt: string,
  canChange: boolean,
): RoutingSettings {
  return {
    strategy: strategyForPolicy(policy),
    revision: `${policy}:${changedAt}`,
    changedAt,
    canChange,
    choices: [
      {
        strategy: "quota-deadline",
        label: "Use quota before it resets",
        description: "Pace new sessions using remaining quota, reset times and recent demand.",
      },
      {
        strategy: "round-robin",
        label: "Balance across accounts",
        description: "Spread new sessions evenly across eligible accounts.",
      },
    ],
  };
}

function evidence(value: unknown): RoutingDecision["forecast"] {
  if (value === null) return null;
  if (!object(value) || !object(value.history)) return unavailable();
  const source = choice(value.source, ["history-forecast", "observed-quota-burn"]);
  return {
    source,
    revision: bounded(value.revision),
    status: source === "history-forecast" ? "calibrated" : "observed",
    confidence: choice(value.confidence, ["low", "medium", "high"] as const),
    calculatedAt: instant(value.calculatedAt),
    validUntil: instant(value.validUntil),
    historyFrom: instant(value.history.from),
    historyThrough: instant(value.history.through),
    coverageRatio: ratio(value.history.coverageRatio),
    heldOutPeriods: finite(value.history.heldOutPeriods),
    backtestRelativeError:
      value.history.relativeError === null ? null : finite(value.history.relativeError),
    unit: object(value.unit)
      ? {
          id: bounded(value.unit.id),
          label: bounded(value.unit.label),
          calibrationRevision: bounded(value.unit.revision),
        }
      : null,
    reasons: [],
  };
}

function candidate(value: Json, accounts: ReadonlyMap<string, string>): RoutingCandidate {
  const account = accounts.get(bounded(value.account)) ?? null;
  if (account === null) return { account: null, display: "withheld" };
  const eligible = value.eligible;
  if (typeof eligible !== "boolean") return unavailable();
  const quota = object(value.quota) ? value.quota : null;
  const short = quota !== null && object(quota.fiveHour) ? quota.fiveHour : null;
  // Account inspection is decided by the host at read time, including removed
  // memberships. Historical Home references never become public identities.
  const inspectable = account !== null;
  return {
    account,
    display: "inspectable",
    eligible,
    funding: choice(value.funding, ["plan", "credits", "unknown", "blocked"]),
    reason: choice(value.reason, [
      "target-share",
      "balanced-fallback",
      "affinity",
      "parent-affinity",
      "pinned",
      "credits-last-resort",
      "quota-exhausted",
      "cooldown",
      "concurrency-full",
      "model-incompatible",
      "disabled",
      "no-target-spill",
      "unavailable",
      "existing-affinity",
      "pinned-account",
    ]),
    quota:
      !inspectable || quota === null
        ? null
        : {
            remainingRatio: ratio(quota.remainingRatio),
            window: quota.windowSeconds === 18000 ? "five-hour" : "weekly",
            resetAt: instant(quota.resetAt),
            observedAt: instant(quota.observedAt),
            staleAt: instant(quota.staleAt),
          },
    fiveHour:
      !inspectable || short === null
        ? null
        : {
            remainingRatio: ratio(short.remainingRatio),
            resetAt: nullableInstant(short.resetAt),
            mode: short.mode === "fixed" || short.mode === "rolling" ? short.mode : "unknown",
          },
    targetBurnRate:
      !inspectable || value.targetBurnRate === null ? null : finite(value.targetBurnRate),
    projectedEmptyAt: nullableInstant(value.projectedEmptyAt),
    emptyProjection: choice(value.emptyProjection, [
      "estimated",
      "not-before-reset",
      "unavailable",
    ]),
    weight: !inspectable || value.weight === null ? null : ratio(value.weight),
  };
}

function routingPlan(value: Json, accounts: ReadonlyMap<string, string>) {
  if (!Array.isArray(value.candidates) || value.candidates.length > 500) return unavailable();
  const strategies = [
    "quota-deadline",
    "round-robin",
    "fill-first",
    "weighted-round-robin",
  ] as const;
  return {
    configuredStrategy: choice(value.configuredStrategy, strategies),
    effectiveStrategy: choice(value.effectiveStrategy, strategies),
    mode: choice(value.mode, [
      "forecast-paced",
      "observed-paced",
      "deadline-rate",
      "balanced-fallback",
      "configured-strategy",
      "affinity",
      "pinned",
      "refused",
    ]),
    reason: choice(value.reason, [
      "deadline-budget",
      "observed-burn-target",
      "uncalibrated-demand",
      "forecast-expired",
      "unknown-rank",
      "invalid-rank",
      "expired-rank",
      "credits-only",
      "existing-affinity",
      "parent-affinity",
      "pinned-account",
      "configured-strategy",
      "no-eligible-account",
    ]),
    forecast: evidence(value.forecast),
    targetThrough: nullableInstant(value.targetThrough),
    candidates: rows(value.candidates).map((entry) => candidate(entry, accounts)),
  };
}

export function routingDecision(
  value: Json,
  accounts: ReadonlyMap<string, string>,
): RoutingDecision {
  if (!Array.isArray(value.attempts) || value.attempts.length > 500) return unavailable();
  return {
    ...routingPlan(value, accounts),
    id: bounded(value.id),
    at: instant(value.at),
    model: bounded(value.model),
    chosenAccount:
      value.chosenAccount === null ? null : (accounts.get(bounded(value.chosenAccount)) ?? null),
    outcome: choice(value.outcome, ["admitted", "refused"]),
    attempts: rows(value.attempts).flatMap((attempt) => {
      const account = accounts.get(bounded(attempt.account));
      return account === undefined
        ? []
        : [
            {
              account,
              outcome: choice(attempt.outcome, ["admitted", "concurrency-full", "unavailable"]),
            },
          ];
    }),
    usageRecord: null,
  };
}

function routingCurrent(value: Json, accounts: ReadonlyMap<string, string>): RoutingNow {
  if (!object(value.plan)) return unavailable();
  return {
    ...routingPlan(value.plan, accounts),
    provider: bounded(value.provider),
    modelFamily: value.modelFamily === null ? null : bounded(value.modelFamily),
    scope: choice(value.scope, ["account-windows", "model"]),
    computedAt: instant(value.computedAt),
    validUntil: instant(value.validUntil),
    status: choice(value.status, ["available", "unavailable"]),
  };
}

export function routingDecisionsView(
  pages: readonly Json[],
  policy: string,
  updatedAt: string,
  mappings: readonly { account: string; home: readonly string[] }[],
): RoutingDecisionsPage {
  const accounts = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const mapping of mappings)
    for (const id of mapping.home) {
      if (accounts.has(id) && accounts.get(id) !== mapping.account) ambiguous.add(id);
      else accounts.set(id, mapping.account);
    }
  for (const id of ambiguous) accounts.delete(id);
  const byId = new Map<string, RoutingDecision>();
  const current = new Map<string, RoutingNow>();
  const capacity = new Map<string, ReturnType<typeof capacityOutlook>>();
  let from = new Date().toISOString(),
    through = from,
    truncated = false;
  for (const page of pages) {
    if (
      !object(page.retention) ||
      page.retention.persistence !== "runtime" ||
      !Array.isArray(page.decisions)
    )
      return unavailable();
    const start = instant(page.retention.from),
      end = instant(page.retention.through);
    if (start < from) from = start;
    if (end > through) through = end;
    if (typeof page.retention.truncated !== "boolean") return unavailable();
    truncated ||= page.retention.truncated || page.next !== null;
    for (const entry of rows(page.capacity)) {
      const outlook = capacityOutlook(entry);
      const key = JSON.stringify([outlook.provider, outlook.modelFamily]);
      if (
        !capacity.has(key) ||
        capacity.get(key)!.evidence.calculatedAt < outlook.evidence.calculatedAt
      )
        capacity.set(key, outlook);
    }
    for (const entry of rows(page.current)) {
      const snapshot = routingCurrent(entry, accounts);
      const key = JSON.stringify([snapshot.provider, snapshot.modelFamily]);
      if (!current.has(key) || current.get(key)!.computedAt < snapshot.computedAt)
        current.set(key, snapshot);
    }
    for (const entry of rows(page.decisions)) {
      const decision = routingDecision(entry, accounts);
      byId.set(decision.id, decision);
    }
  }
  const decisions = [...byId.values()]
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .slice(0, 20);
  return {
    settings: routingSettings(policy, updatedAt, true),
    decisions,
    current: [...current.values()],
    next: null,
    retention: { from, through, truncated: truncated || byId.size > 20, persistence: "runtime" },
    capacity: [...capacity.values()],
  };
}
