import type { Provider } from "../contract.ts";
import { labName } from "./lab-name.ts";
import { formatCount, plural } from "./summary-format.ts";

// Lab names wait for the pool view; its pending or missing entries keep the neutral mark.
export function summaryLabName(providers: readonly Provider[], id: string | null) {
  return id === null ? "Unknown lab" : labName(providers, id);
}

/** Counts-only rows and missing metadata must never be described as proven gateway refusals. */
export function summaryLabExplanation(
  groups: readonly {
    provider: string | null;
    countsOnly: boolean;
    buckets: readonly { requests: number; failed: number; refusedBeforeLab?: number }[];
  }[],
) {
  let refused = 0,
    missing = 0,
    failed = 0,
    withheld = 0;
  for (const group of groups) {
    if (group.provider !== null) continue;
    for (const bucket of group.buckets) {
      if (group.countsOnly) withheld += bucket.requests;
      else {
        const beforeLab = bucket.refusedBeforeLab ?? 0;
        refused += beforeLab;
        missing += bucket.requests - beforeLab;
        failed += bucket.failed - beforeLab;
      }
    }
  }
  const reasons = [
    refused > 0 ? `${formatCount(refused)} failed before reaching a lab.` : null,
    missing > 0
      ? `${plural(missing, "request has", "requests have")} no lab recorded${failed > 0 ? `; ${formatCount(failed)} failed` : ""}.`
      : null,
    withheld > 0
      ? `Lab details are withheld for ${plural(withheld, "request", "requests")} from accounts you can't inspect.`
      : null,
  ].filter((reason) => reason !== null);
  return reasons.length ? reasons.join(" ") : null;
}
