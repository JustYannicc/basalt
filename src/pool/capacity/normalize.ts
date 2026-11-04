import type { QuotaObservation, QuotaWindowObservation } from "../quota-observation.ts";
import { capacityWeight, type CapacityWeight } from "./weights.ts";

export interface CapacityReading {
  readonly account: string;
  readonly provider: string;
  readonly plan: string | null;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly observedAt: number;
  readonly resetAt: number | null;
  readonly staleAt: number | null;
  readonly observationSource: string | null;
  readonly full: number;
  readonly remaining: number;
  readonly unit: { readonly id: string; readonly label: string };
  readonly source: CapacityWeight["source"] | "reported-absolute";
  readonly knownWeight: boolean;
  readonly revision: string;
}

const absoluteUnits = new Set(["tokens", "requests", "credits"]);
const time = (value: string | null): number | null => {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? at : null;
};
const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

/** Identify reported account allowances without mistaking model limits for extra accounts. */
export function capacityWindows(provider: string, windows: readonly QuotaWindowObservation[]) {
  return windows.filter((window) => {
    if (window.unlimited || window.period.seconds !== 18_000 && window.period.seconds !== 604_800) return false;
    if (provider === "claude" || provider === "anthropic")
      return window.id === "claude-five-hour" || window.id === "claude-seven-day";
    return window.scope === "account" && (!window.scopeId || window.scopeId.toLowerCase() === provider);
  });
}

function mainWindows(provider: string, windows: readonly QuotaWindowObservation[]) {
  const candidates = capacityWindows(provider, windows);
  return candidates.filter((window) => candidates.filter((other) => other.period.seconds === window.period.seconds).length === 1);
}

/** Preserve observation-time contributions. A later plan change must not rewrite historical weights. */
export function capacityReadings(account: string, provider: string, quota: QuotaObservation, now: number): CapacityReading[] {
  const collectedAt = time(quota.observedAt);
  if (collectedAt === null || collectedAt > now) return [];
  if (quota.collection.freshness !== "fresh" || !["success", "partial"].includes(quota.collection.status ?? "")) return [];
  return mainWindows(provider, quota.windows).flatMap((window) => {
    const observedAt = time(window.observedAt), staleAt = time(window.staleAt ?? quota.staleAt);
    if (observedAt === null || observedAt > now || staleAt !== null && staleAt <= now) return [];
    if (!["healthy", "low", "exhausted"].includes(String(window.raw.status))) return [];
    const plan = quota.plan?.name ?? null;
    const weight = capacityWeight(provider, plan, window.period.seconds!);
    const absolute = absoluteUnits.has(window.unit ?? "") && positive(window.limit)
      && window.remaining !== null && window.remaining >= 0 && window.remaining <= window.limit;
    const ratio = window.remainingRatio ?? (window.usedRatio === null ? null : 1 - window.usedRatio);
    if (!absolute && (ratio === null || ratio < 0 || ratio > 1)) return [];
    return [{
      account, provider, plan, windowSeconds: window.period.seconds!, mode: window.period.mode, observedAt,
      resetAt: time(window.resetAt), staleAt, observationSource: window.source ?? quota.source,
      full: absolute ? window.limit! : weight.multiplier,
      remaining: absolute ? window.remaining! : weight.multiplier * ratio!,
      unit: absolute ? {
        id: JSON.stringify([provider, window.unit, window.currency, window.scope, window.scopeId, window.source ?? quota.source]),
        label: window.currency ? `${window.unit} (${window.currency})` : window.unit!,
      } : weight.unit,
      source: absolute ? "reported-absolute" as const : weight.source,
      knownWeight: absolute || weight.known,
      revision: weight.revision,
    }];
  });
}
