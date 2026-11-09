import { awaitProbe, probeBudgetMs, type ProbeDependencies } from "./availability.ts";
import { validProbeTarget } from "./availability-config.ts";
import { HomeTransportFailure } from "./json.ts";
import type { AutomaticSample } from "./automatic-recovery.ts";

/** This deliberately excludes failures that the exact-current-boot restart cannot fence. */
export async function observeAutomaticPool(
  pool: string,
  deps: ProbeDependencies,
  signal = AbortSignal.timeout(probeBudgetMs),
): Promise<AutomaticSample["condition"]> {
  if (!validProbeTarget(pool)) return "data-invalid";
  const [health, view, membership] = await Promise.allSettled([
    awaitProbe(() => deps.runtime(signal), signal),
    awaitProbe(() => deps.view(pool, signal), signal),
    (async (): Promise<AutomaticSample["condition"] | undefined> => {
      const { policy, failure } = await awaitProbe(() => deps.membership(pool), signal);
      if (failure) return failure.backendStatus === 400 ? "policy-invalid" : "unknown";
      if (
        !policy ||
        policy.dirty ||
        !policy.native ||
        policy.installedRevision !== policy.revision ||
        policy.installedUntil <= (deps.now?.() ?? Date.now())
      )
        return "policy-invalid";
      try {
        await awaitProbe(() => deps.native(policy, signal), signal);
      } catch {
        return "policy-invalid";
      }
      return undefined;
    })(),
  ]);
  if (membership.status === "rejected") return "unknown";
  if (membership.value !== undefined) return membership.value;
  if (health.status === "rejected") return "unready";
  if (view.status === "fulfilled") return "healthy";
  return (view.reason instanceof HomeTransportFailure &&
    ["transport", "timeout"].includes(view.reason.errorClass)) ||
    (view.reason instanceof DOMException && view.reason.name === "TimeoutError")
    ? "view-transport"
    : "unknown";
}
