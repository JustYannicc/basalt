import { executionKey, type SlotIdentity } from "./contract.ts";

/**
 * The endpoint's own latest readiness proof per boot, on this isolate's monotonic clock.
 *
 * A model request is admitted by the controller on the endpoint's answer to its health read. When
 * that request then arrives for dispatch, the endpoint reuses its own proof while the lease it
 * granted is still current, instead of reading readiness a second time: a second read that came
 * back late or during a flip refused requests the runtime was serving. A spent lease reads again.
 */
export class RuntimeAdmissionLeases {
  private leases = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }
  prove(identity: SlotIdentity, leaseMs: number) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) return;
    const key = executionKey(identity);
    this.leases.set(key, Math.max(this.leases.get(key) ?? 0, this.now() + leaseMs));
  }
  current(identity: SlotIdentity) {
    const until = this.leases.get(executionKey(identity));
    return until !== undefined && until > this.now();
  }
  forget(identity: SlotIdentity) {
    this.leases.delete(executionKey(identity));
  }
}
