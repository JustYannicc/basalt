import { PoolDependencyFailure } from "./dependency-failure.ts";
import { runtimeFailureCode, runtimeRouteDiagnostic } from "./runtime-route-diagnostic.ts";
import {
  BackendFailure,
  diagnosePoolFailure,
  HomeTransportFailure,
  type PoolFailureDiagnostic,
} from "./json.ts";

function diagnostic(error: unknown): Omit<PoolFailureDiagnostic, "guard"> {
  if (error instanceof BackendFailure)
    return {
      failure: "response_status",
      ...(Number.isInteger(error.backendStatus) &&
      error.backendStatus >= 100 &&
      error.backendStatus <= 599
        ? { backendStatus: error.backendStatus }
        : {}),
    };
  if (error instanceof HomeTransportFailure) return { failure: error.errorClass };
  if (error instanceof PoolDependencyFailure) {
    if (error.dependency === "storage") return { failure: "storage" };
    if (error.cause instanceof DOMException && error.cause.name === "TimeoutError")
      return { failure: "timeout" };
    return { failure: "transport" };
  }
  // A selected runtime's refusal crosses the private binding with its closed code; keep it.
  const runtime = runtimeRouteDiagnostic(error);
  if (runtime) return { failure: "runtime_refused", runtime: runtimeFailureCode(runtime) };
  return { failure: "unknown" };
}

/** Preserve nested body/status diagnostics and the original error's caller-visible behavior. */
export async function poolGuard<A>(
  guard: PoolFailureDiagnostic["guard"],
  read: () => Promise<A>,
): Promise<A> {
  try {
    return await read();
  } catch (error) {
    throw diagnosePoolFailure(error, { guard, ...diagnostic(error) });
  }
}
