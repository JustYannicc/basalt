import { codeHandoverHeader } from "./code-handover.ts";
import {
  runtimeResponseCause,
  runtimeResponseDiagnostic,
  runtimeRouteDiagnostic,
  stripRuntimeFailureHeaders,
} from "./runtime-route-diagnostic.ts";
import { nativeRuntimeUnavailable } from "./runtime-unavailable.ts";

/**
 * The controller's mark on a model call it dispatched that reached no runtime: the runtime's own
 * endpoint refused it before its container send. The entry, which still holds the call, sends it
 * again inside its replay window. The mark never reaches a client.
 */
export const controllerUnsentHeader = "X-Signalbox-Controller-Unsent";

// The endpoint's steps before its container send. Its catch-all step stays out: a failure after the
// container already answered could carry it too.
const beforeContainer = new Set([
  "endpoint_identity",
  "endpoint_admission",
  "endpoint_health",
  "endpoint_request",
  "port_lookup",
]);

/** Whether a dispatched call's failure proves that no byte of it reached a container. */
export function reachedNoContainer(error: unknown) {
  const step = runtimeRouteDiagnostic(error)?.runtimeStep;
  return step !== undefined && beforeContainer.has(step);
}

/** The retryable refusal clients already follow, marked for the entry. */
export function unsentRefusal(request: Request, error?: unknown) {
  const response = nativeRuntimeUnavailable(request, error);
  response.headers.set("Retry-After", "1");
  response.headers.set(controllerUnsentHeader, "1");
  return response;
}

export const sentNowhere = (response: Response) =>
  response.status === 503 && response.headers.get(controllerUnsentHeader) === "1";

/** The answer as the client may see it. */
export function withoutUnsentMark(response: Response) {
  if (response.status === 101 || !response.headers.has(controllerUnsentHeader)) return response;
  const headers = new Headers(response.headers);
  headers.delete(controllerUnsentHeader);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * A container's own answer can't speak for the pool. Its refusal steps, handover mark and unsent
 * mark are removed where it enters the pool, so only the endpoint itself can prove a call unsent.
 */
export function containerAnswer(response: Response) {
  if (
    response.status === 101 ||
    (!response.headers.has(controllerUnsentHeader) &&
      !response.headers.has(codeHandoverHeader) &&
      runtimeResponseDiagnostic(response) === undefined &&
      runtimeResponseCause(response) === undefined)
  )
    return response;
  const headers = new Headers(response.headers);
  stripRuntimeFailureHeaders(headers);
  headers.delete(controllerUnsentHeader);
  headers.delete(codeHandoverHeader);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
