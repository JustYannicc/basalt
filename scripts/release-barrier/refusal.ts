import type { ResourceDelta } from "./prop-diff.ts";

export type PlanRefusal = { reason: string } | ({ reason: string } & ResourceDelta);

export class BarrierRefusal extends Error {
  readonly reason: string;
  readonly worker: string | undefined;
  readonly delta: ResourceDelta | undefined;
  readonly refusals: readonly PlanRefusal[] | undefined;

  constructor(
    reason: string,
    worker?: string,
    delta?: ResourceDelta,
    refusals?: readonly PlanRefusal[],
  ) {
    super(`Release barrier refused: ${reason}${worker ? ` (${worker})` : ""}`);
    this.reason = reason;
    this.worker = worker;
    this.delta = delta;
    this.refusals = refusals;
  }
}
