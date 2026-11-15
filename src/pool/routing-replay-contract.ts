import type { RoutingStrategy } from "../../apps/pool/routing-contract.ts";
import type { RoutingDemandInput } from "./routing-demand-contract.ts";

export interface ReplayQuotaWindow {
  readonly seconds: 604800 | 18000;
  readonly mode: "fixed" | "rolling";
  readonly full: number;
  readonly remaining: number;
  readonly resetAt: number | null;
  /** Complete future releases of already consumed rolling quota; null means unknown. */
  readonly rollingReleases: readonly { readonly at: number; readonly amount: number }[] | null;
}

export interface ReplayRoutingAccount {
  readonly id: string;
  readonly usable: boolean;
  readonly windows: readonly ReplayQuotaWindow[];
  /** Observed fixed share of the supplied workload, a stated replay assumption rather than a new routing setting. */
  readonly affinityShare?: number;
}

export interface RoutingReplayInput {
  readonly now: number;
  readonly through: number;
  readonly strategy: RoutingStrategy;
  readonly demand: RoutingDemandInput;
  readonly scenario: "median" | "upper-80";
  readonly accounts: readonly ReplayRoutingAccount[];
  /** Counterfactual allocation can remove affinity to distinguish concentration from intrinsic shortage. */
  readonly ignoreAffinity?: boolean;
}

export interface RoutingReplayResult {
  readonly status: "estimated" | "unavailable";
  readonly basis: "fluid-fixed-model-mix";
  readonly reasons: readonly string[];
  readonly demanded: number;
  readonly served: number;
  readonly unserved: number;
  readonly expiredUnused: number;
  readonly firstShortfallAt: number | null;
  /** Conservative aggregate supply bound, not an assertion that every allocation is feasible. */
  readonly provenCapacityShortfall: number;
  readonly maximumBucketDemand: number;
  readonly firstDayByAccount: Readonly<Record<string, number>>;
}

export interface RoutingReplayPlan {
  readonly label: string;
  readonly windows: readonly Omit<ReplayQuotaWindow, "remaining" | "resetAt" | "rollingReleases">[];
}
