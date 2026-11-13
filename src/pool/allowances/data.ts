import type { PlanAllowance, PlanAllowanceCatalog } from "apps";
import seed from "./seed.json" with { type: "json" };

export type { PlanAllowance, PlanAllowanceCatalog };
export const dayMs = 86_400_000;
export const sourceMaxAge = 14 * dayMs;
export const datasetUrl = "https://planyield.dev/data/calculator.json";
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function date(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : NaN;
}
export const https = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 2048 && /^https:\/\//.test(value);
export const seedCatalog = seed as PlanAllowanceCatalog;
export const allowanceKey = (entry: Pick<PlanAllowance, "vendor" | "plan" | "windowSeconds">) =>
  JSON.stringify([entry.vendor, entry.plan, entry.windowSeconds]);

/** Check dates belong to the source, not the HTTP cache or this process. */
export function allowanceEntry(
  input: Omit<PlanAllowance, "revision" | "expiresAt"> & { expiresAt?: number },
): PlanAllowance {
  return {
    ...input,
    expiresAt: input.expiresAt ?? input.checkedAt! + sourceMaxAge,
    revision: "pending",
  };
}
