import type { ProbeRuntimeIdentity } from "../telemetry/pool-probe-identity.ts";
export type { ProbeRuntimeIdentity } from "../telemetry/pool-probe-identity.ts";
import type { NativeMembershipPolicy } from "./membership-contract.ts";
import { poolFailureDiagnostic, type PoolFailureDiagnostic } from "./json.ts";
import { validProbeTarget } from "./availability-config.ts";
import type { PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";

export const probeBudgetMs = 20_000;

export interface ProbeFailure {
  guard:
    | "configuration"
    | "runtime"
    | "pool_view"
    | "membership"
    | "native_guard"
    | "request_reliability"
    | PoolFailureDiagnostic["guard"];
  reason:
    | "invalid_target"
    | "stopped"
    | "unavailable"
    | "invalid_body"
    | "missing"
    | "dirty"
    | "unacknowledged"
    | "renewal_overdue"
    | "failing_now"
    | "below_target"
    | "collection_unavailable"
    | PoolFailureDiagnostic["failure"];
  backendStatus?: number;
}
export interface ProbeResult {
  ok: boolean;
  failures: ProbeFailure[];
  reliability?: PoolReliabilitySlo;
  runtime?: ProbeRuntimeIdentity;
}

interface ProbePolicy extends NativeMembershipPolicy {
  native: boolean;
  installedRevision: number;
  installedUntil: number;
}
export interface ProbeDependencies {
  runtime(signal: AbortSignal): Promise<void>;
  view(pool: string, signal: AbortSignal): Promise<void>;
  membership(pool: string): Promise<{ policy?: ProbePolicy; failure?: PoolFailureDiagnostic }>;
  native(policy: NativeMembershipPolicy, signal: AbortSignal): Promise<void>;
  now?: () => number;
}

export async function awaitProbe<A>(work: () => Promise<A>, signal: AbortSignal): Promise<A> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(), stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Each observation is read-only. A failed view still leaves the guard check observable. */
export async function probePool(pool: string, deps: ProbeDependencies): Promise<ProbeResult> {
  if (!validProbeTarget(pool))
    return { ok: false, failures: [{ guard: "configuration", reason: "invalid_target" }] };
  const signal = AbortSignal.timeout(probeBudgetMs);
  const failures: ProbeFailure[] = [];
  async function observe(guard: "runtime" | "pool_view", read: () => Promise<void>) {
    try {
      await awaitProbe(read, signal);
    } catch (error) {
      const diagnostic = poolFailureDiagnostic(error);
      failures.push(
        diagnostic
          ? {
              guard: diagnostic.guard,
              reason: diagnostic.failure,
              ...(diagnostic.backendStatus ? { backendStatus: diagnostic.backendStatus } : {}),
            }
          : { guard, reason: "unavailable" },
      );
    }
  }
  await Promise.all([
    observe("runtime", () => deps.runtime(signal)),
    observe("pool_view", () => deps.view(pool, signal)),
    (async () => {
      try {
        const { policy, failure } = await awaitProbe(() => deps.membership(pool), signal);
        if (failure)
          failures.push({
            guard: failure.guard,
            reason: failure.failure,
            ...(failure.backendStatus ? { backendStatus: failure.backendStatus } : {}),
          });
        if (!policy) {
          failures.push({ guard: "membership", reason: "missing" });
          return;
        }
        if (policy.dirty || !policy.native) failures.push({ guard: "membership", reason: "dirty" });
        else if (policy.installedRevision !== policy.revision)
          failures.push({ guard: "membership", reason: "unacknowledged" });
        else if (policy.installedUntil <= (deps.now?.() ?? Date.now()))
          failures.push({ guard: "membership", reason: "renewal_overdue" });
        try {
          await awaitProbe(() => deps.native(policy, signal), signal);
        } catch {
          failures.push({ guard: "native_guard", reason: "unavailable" });
        }
      } catch {
        failures.push({ guard: "membership", reason: "unavailable" });
      }
    })(),
  ]);
  return { ok: failures.length === 0, failures };
}
