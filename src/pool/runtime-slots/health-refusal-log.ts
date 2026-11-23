import { runtimeFailureCode, runtimeFailureDiagnostic } from "../runtime-route-diagnostic.ts";
import type { PoolStatus } from "../lifecycle.ts";
import { runtimeReadySignals } from "../runtime-ready-signals.ts";
import type { SlotIdentity } from "./contract.ts";
import type { WitnessRecord } from "./witness-store.ts";

const repeatMs = 60_000;
const keptKeys = 8;

/**
 * One closed line per distinct health refusal, and at most one a minute for each while it repeats,
 * even when callers alternate between them. It says what the endpoint saw: its record, the
 * container, and the readiness answer, never a value from either. The answer's own signals appear
 * only as the Worker decoded them, and stay out of the repeat key with the lease, so a moving count
 * never defeats the throttle.
 */
export class RuntimeHealthRefusalLog {
  private logged = new Map<string, number>();
  report(
    identity: SlotIdentity,
    error: unknown,
    running: boolean | undefined,
    record?: WitnessRecord,
    status?: PoolStatus,
  ) {
    const witness = record?.witness;
    const ready = runtimeReadySignals(error) ?? status?.ready;
    const fields = {
      slot: identity.slotId,
      code: runtimeFailureCode(runtimeFailureDiagnostic(error, "endpoint_identity")),
      running: running ?? null,
      identity: record === undefined ? "unread" : record.identity ? "recorded" : "missing",
      witness: !witness ? "missing" : witness.bootId ? "booted" : "pending",
      readinessBoot: !status
        ? "unread"
        : status.boot_id === record?.identity?.bootId
          ? "match"
          : "differs",
      launch:
        !status || !witness
          ? "unread"
          : status.launch?.generation === witness.launch.generation &&
              status.launch.tokenHash === witness.launch.tokenHash
            ? "match"
            : "differs",
      ...(status?.policyLeaseUntil
        ? { leaseMs: Math.round(status.policyLeaseUntil - performance.now()) }
        : {}),
      ...(ready ? { ready } : {}),
    };
    const key = JSON.stringify({ ...fields, leaseMs: undefined, ready: undefined });
    const now = Date.now();
    const at = this.logged.get(key);
    if (at !== undefined && now - at < repeatMs) return;
    this.logged.delete(key);
    this.logged.set(key, now);
    const oldest = this.logged.keys().next().value;
    if (this.logged.size > keptKeys && oldest !== undefined) this.logged.delete(oldest);
    console.error("POOL_RUNTIME_HEALTH_REFUSED", JSON.stringify(fields));
  }
}
