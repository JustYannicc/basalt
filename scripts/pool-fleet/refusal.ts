import type { ResourceDelta } from "./prop-diff.ts";

export type PlanRefusal = { reason: string } | ({ reason: string } & ResourceDelta);

export interface StateStoreVersionDiagnostic {
  phase: "release" | "forward-probe";
  expected: number;
  observed: number;
}

export class BarrierRefusal extends Error {
  readonly reason: string;
  readonly worker: string | undefined;
  readonly delta: ResourceDelta | undefined;
  readonly refusals: readonly PlanRefusal[] | undefined;
  readonly stateStore: StateStoreVersionDiagnostic | undefined;

  constructor(
    reason: string,
    worker?: string,
    delta?: ResourceDelta,
    refusals?: readonly PlanRefusal[],
    stateStore?: StateStoreVersionDiagnostic,
  ) {
    super(`Release barrier refused: ${reason}${worker ? ` (${worker})` : ""}`);
    this.reason = reason;
    this.worker = worker;
    this.delta = delta;
    this.refusals = refusals;
    this.stateStore = stateStore;
  }
}
