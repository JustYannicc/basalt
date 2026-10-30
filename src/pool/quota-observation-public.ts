import type { PoolAccountObservation } from "../../apps/pool/account-observation-contract.ts";
import type { QuotaObservation, QuotaWindowObservation } from "./quota-observation.ts";

const bounded = (value: string | null, length = 64) => value?.trim().slice(0, length) || undefined;
const instant = (value: string | null): string | undefined => {
  const time = value === null ? NaN : Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const iso = new Date(time).toISOString();
  return /^\d{4}-/.test(iso) ? iso : undefined;
};
const ratio = (value: number | null) => value !== null && value >= 0 && value <= 1 ? value : undefined;

function label(window: QuotaWindowObservation): string {
  const named = bounded(window.label);
  if (named) return named;
  const seconds = window.period.seconds;
  if (seconds === 604_800) return "Weekly";
  if (seconds !== null && seconds > 0) {
    for (const [duration, unit] of [[86_400, "days"], [3_600, "hours"], [60, "minutes"], [1, "seconds"]] as const) {
      if (seconds % duration === 0) return `${seconds / duration} ${unit}`;
    }
  }
  return "Allowance";
}

/** Explicit public projection; identifiers, diagnostic bodies and raw future fields stay internal. */
export function publicQuotaObservation(value: QuotaObservation): PoolAccountObservation | null {
  const observedAt = instant(value.observedAt);
  if (observedAt === undefined) return null;
  const windows = value.windows.flatMap((window) => {
    const id = bounded(window.id), unit = bounded(window.currency ?? window.unit), at = instant(window.observedAt);
    if (id === undefined || unit === undefined || at === undefined) return [];
    const mode = window.period.mode ?? window.mode;
    const seconds = window.period.seconds;
    return [{
      id, label: label(window), observedAt: at,
      ...(instant(window.staleAt) === undefined ? {} : { staleAt: instant(window.staleAt) }),
      ...(bounded(window.scope, 128) === undefined ? {} : { scope: { kind: bounded(window.scope, 128)!, ...(bounded(window.scopeId, 128) === undefined ? {} : { id: bounded(window.scopeId, 128) }) } }),
      measure: {
        unit,
        ...(window.used === null ? {} : { used: window.used }),
        ...(window.remaining === null ? {} : { remaining: window.remaining }),
        ...(window.limit === null ? {} : { limit: window.limit }),
        ...(ratio(window.remainingRatio) === undefined ? {} : { remainingRatio: ratio(window.remainingRatio) }),
        ...(window.unlimited === null ? {} : { unlimited: window.unlimited }),
      },
      period: {
        ...(mode === "fixed" || mode === "rolling" ? { mode } : {}),
        ...(seconds !== null && seconds > 0 ? { seconds } : {}),
        ...(bounded(window.period.unit) === undefined ? {} : { unit: bounded(window.period.unit) }),
        ...(window.period.value === null ? {} : { value: window.period.value }),
      },
      ...(instant(window.resetAt) === undefined ? {} : { resetsAt: instant(window.resetAt) }),
    }];
  }).slice(0, 8);
  const balances: PoolAccountObservation["observation"]["balances"][number][] = [];
  const resets = value.resets;
  if (resets !== null && resets.available !== null && resets.available >= 0) {
    const groups = new Map<string, number>();
    for (const credit of resets.credits) {
      if (credit.status !== "available") continue;
      const expiry = instant(credit.expiresAt) ?? "unknown";
      groups.set(expiry, (groups.get(expiry) ?? 0) + 1);
    }
    const listed = [...groups.values()].reduce((total, count) => total + count, 0);
    if (listed > resets.available) groups.clear();
    const known = [...groups.values()].reduce((total, count) => total + count, 0);
    if (resets.available > known || groups.size === 0) groups.set("unknown", (groups.get("unknown") ?? 0) + resets.available - known);
    for (const [expiry, available] of groups) balances.push({ id: `resets-${balances.length}`, label: "Banked resets", unit: "resets", available,
      observedAt: instant(resets.observedAt) ?? observedAt, ...(expiry === "unknown" ? {} : { expiresAt: expiry }) });
  }
  const attemptedAt = instant(value.collection.attemptedAt);
  const retryAt = instant(value.collection.nextAllowedAt);
  const failed = value.collection.status === "failed";
  const outcome = failed ? value.collection.errorCode === "UPSTREAM_RATE_LIMITED" ? "rate_limited" : "unavailable"
    : value.collection.status === "success" || value.collection.status === "partial" ? "success" : "unavailable";
  const plan = bounded(value.plan?.name ?? null);
  return {
    observedAt,
    observation: {
      offering: "subscription",
      ...(plan === undefined ? {} : { plan: { label: plan, observedAt } }),
      windows, balances: balances.slice(0, 8),
    },
    ...(attemptedAt === undefined ? {} : { collection: { attemptedAt, outcome, ...(retryAt === undefined ? {} : { retryAt }) } }),
  };
}
