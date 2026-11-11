import type { UsageCredits } from "../../apps/pool/usage-credits-contract.ts";
import { object } from "./json.ts";

const decimal = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    ? value
    : null;
const instant = (value: unknown): string | null => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Home emits normalized credit facts. Raw flags, arbitrary fields and money guesses stay private. */
export function usageCredits(value: unknown, now = Date.now()): UsageCredits | undefined {
  if (!object(value)) return undefined;
  const observedAt = instant(value.observed_at);
  const staleAt = instant(value.expires_at);
  const state =
    value.state === "available" ||
    value.state === "unlimited" ||
    value.state === "none" ||
    value.state === "disabled"
      ? value.state
      : "unknown";
  const balance = decimal(value.balance);
  const extra = object(value.extra_usage) ? value.extra_usage : null;
  return {
    state: state === "available" && balance === null ? "unknown" : state,
    balance: balance === null ? null : { value: balance, unit: "credits" },
    observedAt,
    staleAt,
    freshness:
      observedAt === null || staleAt === null
        ? "unknown"
        : Date.parse(observedAt) <= now && now < Date.parse(staleAt)
          ? "fresh"
          : "stale",
    extraUsage:
      extra === null
        ? null
        : {
            enabled: typeof extra.enabled === "boolean" ? extra.enabled : null,
            monthlyCap:
              extra.monthly_cap === "limited" || extra.monthly_cap === "unlimited"
                ? extra.monthly_cap
                : "unknown",
            usedRatio:
              typeof extra.used_ratio === "number" &&
              Number.isFinite(extra.used_ratio) &&
              extra.used_ratio >= 0 &&
              extra.used_ratio <= 1
                ? extra.used_ratio
                : null,
            spent: null,
            cap: null,
          },
  };
}

export function retainedUsageCredits(value: UsageCredits, now: number): UsageCredits {
  if (value.freshness !== "fresh") return value;
  const observed = Date.parse(value.observedAt ?? ""),
    expiry = Date.parse(value.staleAt ?? "");
  return observed <= now && now < expiry ? value : { ...value, freshness: "stale" };
}
