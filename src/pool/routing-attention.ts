import type { CapacityAttention, CapacityOutlook } from "../../apps/pool/routing-contract.ts";

export type CapacityOutlookInput = Omit<CapacityOutlook, "attention">;
export interface CapacityAttentionState {
  readonly key: string;
  readonly episode: string;
  readonly qualifiedSince: number | null;
  readonly lastQualifiedAt: number | null;
}
const day = 24 * 3_600_000;
export const capacityAttentionPolicy = {
  minimumConfidence: "medium",
  minimumCoverageRatio: 0.9,
  minimumHeldOutPeriods: 2,
  noticeHorizonDays: 7,
  inboxHorizonDays: 3,
  confirmationMinutes: 5,
} as const;

/** Returns data for the editable owner-check workflow. It never sends a notification. */
export function capacityAttention(
  outlook: CapacityOutlookInput,
  previous: CapacityAttentionState | null,
  now: number,
): { readonly attention: CapacityAttention; readonly state: CapacityAttentionState | null } {
  const first =
    outlook.scenarios.find((scenario) => scenario.demand === "median")?.firstShortfallAt ?? null;
  const base: CapacityAttention = {
    evaluatedAt: new Date(now).toISOString(),
    notice: "none",
    inboxNudge: "none",
    episode: previous?.episode ?? null,
    firstShortfallAt: first,
    reason: "no-median-shortfall",
    policy: capacityAttentionPolicy,
  };
  const inactive = outlook.status === "enough";
  const hold = (reason: CapacityAttention["reason"]) => ({
    attention: { ...base, reason, ...(inactive ? { episode: null } : {}) },
    state:
      inactive || previous === null
        ? null
        : { ...previous, qualifiedSince: null, lastQualifiedAt: null },
  });
  if (
    (outlook.status !== "needs-more-accounts" && outlook.status !== "routing-waste") ||
    first === null
  )
    return hold("no-median-shortfall");
  const at = Date.parse(first),
    evidence = outlook.evidence;
  if (!Number.isFinite(at) || at > now + 7 * day) return hold("outside-horizon");
  if (
    evidence.validUntil === null ||
    !Number.isFinite(Date.parse(evidence.validUntil)) ||
    !Number.isFinite(Date.parse(evidence.calculatedAt)) ||
    Date.parse(evidence.validUntil) <= now ||
    Date.parse(evidence.calculatedAt) > now
  )
    return hold("stale-evidence");
  if (
    evidence.source !== "history-forecast" ||
    evidence.status !== "calibrated" ||
    evidence.reasons.length ||
    evidence.coverageRatio === null ||
    evidence.coverageRatio < 0.9 ||
    evidence.heldOutPeriods < 2
  )
    return hold("incomplete-evidence");
  if (evidence.confidence !== "medium" && evidence.confidence !== "high")
    return hold("low-confidence");
  const key = JSON.stringify([outlook.provider, outlook.modelFamily, outlook.status]);
  const continuous =
    previous?.key === key &&
    previous.lastQualifiedAt !== null &&
    now - previous.lastQualifiedAt <= 15 * 60_000;
  const state: CapacityAttentionState = {
    key,
    episode: previous?.key === key ? previous.episode : `${key}:${now}`,
    qualifiedSince: continuous ? (previous.qualifiedSince ?? now) : now,
    lastQualifiedAt: now,
  };
  const confirmed = now - state.qualifiedSince! >= 5 * 60_000;
  const near = at <= now + 3 * day;
  return {
    attention: {
      ...base,
      notice: outlook.status,
      episode: state.episode,
      inboxNudge: near && confirmed ? "eligible" : "none",
      reason: !near ? "notice-only" : confirmed ? "within-three-days" : "awaiting-confirmation",
    },
    state,
  };
}
