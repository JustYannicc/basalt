import { runtimeFailureCode, runtimeFailureDiagnostic } from "../runtime-route-diagnostic.ts";
import type { PoolStatus } from "../lifecycle.ts";
import type { SlotIdentity } from "./contract.ts";
import type { WitnessRecord } from "./witness-store.ts";

const repeatMs = 60_000;

/**
 * One closed line per changed health refusal, and at most one a minute while it repeats. On 19 Nov
 * 2026 every read refused for hours and no line said why; this says what the endpoint saw: its
 * record, the container, and the readiness answer, never a value from either.
 */
export class RuntimeHealthRefusalLog {
  private last?: { key: string; at: number };
  report(
    identity: SlotIdentity,
    error: unknown,
    running: boolean | undefined,
    record?: WitnessRecord,
    status?: PoolStatus,
  ) {
    const witness = record?.witness;
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
    };
    const key = JSON.stringify({ ...fields, leaseMs: undefined });
    const now = Date.now();
    if (this.last?.key === key && now - this.last.at < repeatMs) return;
    this.last = { key, at: now };
    console.error("POOL_RUNTIME_HEALTH_REFUSED", JSON.stringify(fields));
  }
}
