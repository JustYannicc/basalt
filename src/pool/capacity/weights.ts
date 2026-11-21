import {
  allowanceProvenance,
  planAllowance,
  type AllowanceProvenance,
  type PlanAllowanceCatalog,
} from "apps";

import { markContradictions, seedCatalog } from "../allowances/data.ts";

export interface CapacityWeight {
  readonly multiplier: number;
  readonly source:
    | "reference-plan"
    | "published-session-multiplier"
    | "published-weekly-multiplier"
    | "reported-plan-multiplier"
    | "account-calibration"
    | "plan-multiplier"
    | "unknown-plan";
  readonly known: boolean;
  readonly unit: { readonly id: string; readonly label: string };
  readonly revision: string;
  readonly allowance?: AllowanceProvenance;
}

export const capacityWeightRevision = "2026-10-30";

/** Values come from account evidence and expiring source data, never from a tier-name table. */
export function capacityWeight(
  provider: string,
  plan: string | null,
  windowSeconds: number,
  options: { readonly catalog?: PlanAllowanceCatalog; readonly now?: number } = {},
): CapacityWeight {
  const catalog = options.catalog ?? seedCatalog;
  const now = options.now ?? Date.now();
  const resolved = planAllowance(catalog, provider, plan, windowSeconds, now);
  const value = resolved.known
    ? resolved
    : (lastKnown(catalog, provider, plan, windowSeconds, resolved, now) ?? resolved);
  return {
    multiplier: value.full,
    source: !value.known
      ? "unknown-plan"
      : value.kind === "account-calibration"
        ? "account-calibration"
        : value.verification === "reference"
          ? "reference-plan"
          : value.verification === "policy"
            ? "plan-multiplier"
            : value.verification === "reported"
              ? "reported-plan-multiplier"
              : windowSeconds === 604_800
                ? "published-weekly-multiplier"
                : "published-session-multiplier",
    known: value.known,
    unit: value.unit,
    revision: value.revision,
    allowance: allowanceProvenance(value),
  };
}

/**
 * Aging is not a policy change: once every row for a plan has expired, the plan keeps what the
 * resolver decided at the last instant a row was live, so its unit and revision, and the capacity
 * training keyed on them, survive until a source decides again. A live row or a later revocation
 * still decides.
 */
function lastKnown(
  catalog: PlanAllowanceCatalog,
  provider: string,
  plan: string | null,
  windowSeconds: number,
  unknown: ReturnType<typeof planAllowance>,
  now: number,
) {
  const candidates = catalog.entries.filter(
    (entry) =>
      entry.vendor === unknown.vendor &&
      entry.plan === unknown.plan &&
      entry.windowSeconds === unknown.windowSeconds &&
      entry.checkedAt !== null &&
      entry.checkedAt <= now,
  );
  if (candidates.some((entry) => entry.expiresAt !== null && entry.expiresAt > now)) return;
  const lastLive = Math.max(
    ...candidates.flatMap((entry) =>
      entry.expiresAt !== null && Number.isFinite(entry.expiresAt) ? [entry.expiresAt - 1] : [],
    ),
  );
  if (!Number.isFinite(lastLive)) return;
  const decided = planAllowance(
    { entries: markContradictions(candidates, lastLive) },
    provider,
    plan,
    windowSeconds,
    lastLive,
  );
  if (
    !decided.known ||
    candidates.some(
      (entry) =>
        entry.verification === "unknown" &&
        entry.sourceId === decided.sourceId &&
        (entry.fetchedAt ?? 0) > (decided.fetchedAt ?? 0),
    )
  )
    return;
  return {
    ...decided,
    detail: `${(decided.detail ?? "Last known allowance").replace(/\.$/u, "")}; its source expired, so the last known value is kept`,
  };
}
