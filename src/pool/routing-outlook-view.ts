import type { CapacityOutlook, ForecastEvidence } from "../../apps/pool/routing-contract.ts";
import { object, rows, unavailable } from "./json.ts";
import { capacityAttentionPolicy } from "./routing-attention.ts";

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value)
    ? value
    : unavailable();
const at = (value: unknown) => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : unavailable();
};
const maybeAt = (value: unknown) => (value === null ? null : at(value));
const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : unavailable();
const ratio = (value: unknown) => {
  const result = amount(value);
  return result <= 1 ? result : unavailable();
};
const choice = <const T extends string>(value: unknown, choices: readonly T[]): T =>
  choices.find((item) => item === value) ?? unavailable();
const strings = (value: unknown, maximum: number) => {
  if (!Array.isArray(value) || value.length > maximum) return unavailable();
  return value.map(text);
};

function forecast(value: unknown): ForecastEvidence {
  if (!object(value)) return unavailable();
  const reasons = strings(value.reasons, 9).map((reason) =>
    choice(reason, [
      "quota-calibration-missing",
      "plan-weight-unknown",
      "quota-reading-stale",
      "reset-unknown",
      "rolling-window-history-missing",
      "history-gap",
      "demand-censored",
      "sticky-demand-uncertain",
      "forecast-expired",
    ] as const),
  );
  return {
    source: choice(value.source, ["history-forecast", "observed-quota-burn", "none"]),
    status: choice(value.status, [
      "calibrated",
      "observed",
      "uncalibrated",
      "stale",
      "insufficient-history",
    ]),
    confidence:
      value.confidence === null ? null : choice(value.confidence, ["low", "medium", "high"]),
    revision: value.revision === null ? null : text(value.revision),
    calculatedAt: at(value.calculatedAt),
    validUntil: maybeAt(value.validUntil),
    historyFrom: maybeAt(value.historyFrom),
    historyThrough: maybeAt(value.historyThrough),
    coverageRatio: value.coverageRatio === null ? null : ratio(value.coverageRatio),
    heldOutPeriods: amount(value.heldOutPeriods),
    backtestRelativeError:
      value.backtestRelativeError === null ? null : amount(value.backtestRelativeError),
    unit:
      value.unit === null
        ? null
        : object(value.unit)
          ? {
              id: text(value.unit.id),
              label: text(value.unit.label),
              calibrationRevision: text(value.unit.calibrationRevision),
            }
          : unavailable(),
    reasons,
  };
}

/** Copy a closed public shape. Private service payload extensions never escape. */
export function capacityOutlook(value: unknown): CapacityOutlook {
  if (
    !object(value) ||
    !object(value.attention) ||
    !Array.isArray(value.scenarios) ||
    value.scenarios.length > 2
  )
    return unavailable();
  const attention = value.attention;
  const policy = attention.policy;
  if (
    !object(policy) ||
    Object.entries(capacityAttentionPolicy).some(([key, expected]) => policy[key] !== expected)
  )
    return unavailable();
  const recommendation = value.recommendation;
  if (
    recommendation !== null &&
    (!object(recommendation) || !object(recommendation.additionalAccounts))
  )
    return unavailable();
  return {
    provider: text(value.provider),
    modelFamily: text(value.modelFamily),
    from: at(value.from),
    through: at(value.through),
    status: choice(value.status, ["enough", "routing-waste", "needs-more-accounts", "uncertain"]),
    evidence: forecast(value.evidence),
    attention: {
      evaluatedAt: at(attention.evaluatedAt),
      notice: choice(attention.notice, ["none", "needs-more-accounts", "routing-waste"]),
      inboxNudge: choice(attention.inboxNudge, ["none", "eligible"]),
      episode: attention.episode === null ? null : text(attention.episode),
      firstShortfallAt: maybeAt(attention.firstShortfallAt),
      reason: choice(attention.reason, [
        "no-median-shortfall",
        "outside-horizon",
        "low-confidence",
        "stale-evidence",
        "incomplete-evidence",
        "awaiting-confirmation",
        "notice-only",
        "within-three-days",
      ]),
      policy: capacityAttentionPolicy,
    },
    scenarios: rows(value.scenarios).map((scenario) => ({
      demand: choice(scenario.demand, ["median", "upper-80"]),
      configuredUnserved: amount(scenario.configuredUnserved),
      feasibleUnserved: amount(scenario.feasibleUnserved),
      expiringUnused: amount(scenario.expiringUnused),
      firstShortfallAt: maybeAt(scenario.firstShortfallAt),
      bottleneck: choice(scenario.bottleneck, [
        "weekly",
        "five-hour",
        "concurrency",
        "sticky",
        "none",
      ]),
    })),
    recommendation:
      recommendation === null
        ? null
        : object(recommendation) && object(recommendation.additionalAccounts)
          ? {
              plan: text(recommendation.plan),
              additionalAccounts: {
                median: amount(recommendation.additionalAccounts.median),
                upper80: amount(recommendation.additionalAccounts.upper80),
              },
              basis: choice(recommendation.basis, ["simulated-refill-schedule"]),
              assumedNewAccountStart: at(recommendation.assumedNewAccountStart),
              constraints: strings(recommendation.constraints, 16),
            }
          : unavailable(),
  };
}
