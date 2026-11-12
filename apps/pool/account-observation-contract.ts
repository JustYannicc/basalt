/** The bounded allowance projection this Worker sends to the pool app. No framework runtime dependency. */
export interface PoolAccountObservation {
  readonly observedAt: string;
  readonly observation: {
    readonly usageCredits?: import("./usage-credits-contract.ts").UsageCredits;
    readonly offering: import("apps").AccountOffering;
    readonly plan?: {
      readonly label: string;
      readonly observedAt: string;
      readonly staleAt?: string;
    };
    readonly windows: readonly {
      readonly id: string;
      readonly label: string;
      readonly observedAt: string;
      readonly staleAt?: string;
      readonly scope?: { readonly kind: string; readonly id?: string };
      readonly measure: {
        readonly unit: string;
        readonly used?: number;
        readonly remaining?: number;
        readonly limit?: number;
        readonly remainingRatio?: number;
        readonly unlimited?: boolean;
      };
      readonly period?: {
        readonly mode?: "fixed" | "rolling";
        readonly seconds?: number;
        readonly unit?: string;
        readonly value?: number;
      };
      readonly resetsAt?: string;
    }[];
    readonly balances: readonly {
      readonly id: string;
      readonly label: string;
      readonly unit: string;
      readonly available: number;
      readonly observedAt: string;
      readonly staleAt?: string;
      readonly expiresAt?: string;
      readonly scope?: import("./reset-observation-contract.ts").ResetScope;
      readonly reset?: import("./reset-observation-contract.ts").ResetMetadata;
    }[];
  };
  readonly collection?: {
    readonly attemptedAt: string;
    readonly outcome: "success" | "unavailable" | "rate_limited";
    readonly retryAt?: string;
  };
}
