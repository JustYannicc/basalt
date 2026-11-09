import { awaitProbe, probeBudgetMs, type ProbeDependencies } from "./availability.ts";
import { validProbeTarget } from "./availability-config.ts";
import { HomeTransportFailure } from "./json.ts";
import type { AutomaticSample } from "./automatic-recovery.ts";

/** This deliberately excludes failures that the exact-current-boot restart cannot fence. */
export async function observeAutomaticPool(
  pool: string,
  deps: ProbeDependencies,
): Promise<AutomaticSample["condition"]> {
  if (!validProbeTarget(pool)) return "data-invalid";
  const signal = AbortSignal.timeout(probeBudgetMs);
  const [health, view, membership] = await Promise.allSettled([
    awaitProbe(() => deps.runtime(signal), signal),
    awaitProbe(() => deps.view(pool, signal), signal),
    awaitProbe(() => deps.membership(pool), signal),
  ]);
  if (membership.status === "rejected") return "unknown";
  const { policy, failure } = membership.value;
  if (failure) return failure.backendStatus === 400 ? "policy-invalid" : "unknown";
  if (
    !policy ||
    policy.dirty ||
    !policy.native ||
    policy.installedRevision !== policy.revision ||
    policy.installedUntil <= (deps.now?.() ?? Date.now())
  )
    return "policy-invalid";
  if (health.status === "rejected") return "unready";
  try {
    await awaitProbe(() => deps.native(policy, signal), signal);
  } catch {
    return "policy-invalid";
  }
  if (view.status === "fulfilled") return "healthy";
  return view.reason instanceof HomeTransportFailure &&
    ["transport", "timeout"].includes(view.reason.errorClass)
    ? "view-transport"
    : "unknown";
}
