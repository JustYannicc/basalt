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
  const value = planAllowance(
    options.catalog ?? seedCatalog,
    provider,
    plan,
    windowSeconds,
    options.now ?? Date.now(),
  );
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
