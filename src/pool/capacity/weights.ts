import {
  allowanceProvenance,
  planAllowance,
  type AllowanceProvenance,
  type PlanAllowanceCatalog,
} from "apps";

import { seedCatalog } from "../allowances/data.ts";

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
  const value = resolved.known ? resolved : (lastKnown(catalog, resolved, now) ?? resolved);
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
 * Aging is not a policy change: when every source for a plan has expired, the plan keeps the
 * value, unit and revision it last had, so capacity training survives until a source decides.
 * A live row (revoked, contradicted or unlimited) or a newer revocation still decides.
 */
function lastKnown(
  catalog: PlanAllowanceCatalog,
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
  const latest = candidates.toSorted(
    (a, b) => (b.fetchedAt ?? b.checkedAt ?? 0) - (a.fetchedAt ?? a.checkedAt ?? 0),
  )[0];
  if (
    !latest ||
    latest.verification === "unknown" ||
    latest.contradicted ||
    latest.unlimited ||
    latest.full === null ||
    !Number.isFinite(latest.full) ||
    latest.full <= 0
  )
    return;
  return {
    ...latest,
    full: latest.full,
    known: true,
    detail: `${latest.detail ?? "Last known allowance"}; its source expired, so the last known value is kept`,
  };
}
