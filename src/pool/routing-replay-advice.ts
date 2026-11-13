import { replayQuotaDeadline } from "./routing-replay.ts";
import type {
  RoutingReplayInput,
  RoutingReplayPlan,
  RoutingReplayResult,
} from "./routing-replay-contract.ts";

export interface RoutingReplayComparison {
  readonly classification:
    | "enough"
    | "routing-waste"
    | "sticky-constraint"
    | "needs-more-accounts"
    | "uncertain";
  readonly configured: RoutingReplayResult;
  readonly quotaDeadline: RoutingReplayResult;
  readonly flexible: RoutingReplayResult;
  readonly additionalAccounts: number | null;
  readonly reasons: readonly string[];
}

/** The forecast owner supplies demand and an evidenced plan. This module owns allocation and sizing replay. */
export function compareRoutingCapacity(
  input: RoutingReplayInput,
  plan?: RoutingReplayPlan,
): RoutingReplayComparison {
  const configured = replayQuotaDeadline(input);
  const quotaDeadline = replayQuotaDeadline({ ...input, strategy: "quota-deadline" });
  const flexible = replayQuotaDeadline({
    ...input,
    strategy: "quota-deadline",
    ignoreAffinity: true,
  });
  const base = { configured, quotaDeadline, flexible, additionalAccounts: null };
  if ([configured, quotaDeadline, flexible].some((result) => result.status !== "estimated"))
    return { ...base, classification: "uncertain", reasons: ["replay-unavailable"] };
  const tolerance = Math.max(configured.demanded, quotaDeadline.demanded, flexible.demanded) * 1e-8;
  if (quotaDeadline.unserved > flexible.unserved + tolerance)
    return {
      ...base,
      classification: "sticky-constraint",
      reasons: ["affinity-consumes-later-deadline-capacity"],
    };
  if (configured.unserved <= tolerance)
    return { ...base, classification: "enough", additionalAccounts: 0, reasons: [] };
  if (quotaDeadline.unserved <= tolerance)
    return { ...base, classification: "routing-waste", additionalAccounts: 0, reasons: [] };
  // A failed heuristic alone is not evidence that more capacity is necessary.
  // Only an independent supply upper bound can establish intrinsic shortfall.
  if (flexible.unserved > flexible.provenCapacityShortfall + tolerance)
    return {
      ...base,
      classification: "uncertain",
      reasons: ["feasible-allocation-not-established"],
    };
  if (!plan || plan.windows.some((window) => !Number.isFinite(window.full) || window.full <= 0))
    return {
      ...base,
      classification: "needs-more-accounts",
      reasons: ["candidate-plan-unavailable"],
    };
  const existing = new Set(input.accounts.map((account) => account.id));
  for (let count = 1; count <= 16; count++) {
    const extra = Array.from({ length: count }, (_, index) => ({
      id: `replay-additional-${index}`,
      usable: true,
      windows: plan.windows.map((window) => ({
        ...window,
        remaining: window.full,
        resetAt: input.now + window.seconds * 1000,
        rollingReleases: [],
      })),
    }));
    if (extra.some((account) => existing.has(account.id)))
      return { ...base, classification: "uncertain", reasons: ["candidate-identity-collision"] };
    const result = replayQuotaDeadline({
      ...input,
      strategy: "quota-deadline",
      accounts: [...input.accounts, ...extra],
    });
    if (result.status !== "estimated")
      return { ...base, classification: "uncertain", reasons: result.reasons };
    if (result.unserved <= tolerance)
      return {
        ...base,
        classification: "needs-more-accounts",
        additionalAccounts: count,
        reasons: [],
      };
  }
  return { ...base, classification: "needs-more-accounts", reasons: ["candidate-search-limit"] };
}
