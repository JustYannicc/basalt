import { canonicalProviderValue } from "../../src/pool/runtime-provider/canonical.ts";
import { createHash } from "node:crypto";
import { BarrierRefusal } from "./refusal.ts";
export { BarrierRefusal, type PlanRefusal } from "./refusal.ts";

export function canonical(value: unknown): string {
  try {
    return canonicalProviderValue(value);
  } catch {
    throw new BarrierRefusal("unsupported-manifest-value");
  }
}

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
