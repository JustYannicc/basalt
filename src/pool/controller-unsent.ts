import { codeHandoverHeader } from "./code-handover.ts";
import type { GatewayFailureDiagnostic } from "./gateway-failure.ts";
import { runtimeRouteDiagnostic } from "./runtime-route-diagnostic.ts";
import { nativeRuntimeUnavailable } from "./runtime-unavailable.ts";

/**
 * The controller's mark on a model call it dispatched that reached no runtime: the runtime's own
 * endpoint refused it before its container send. The entry, which still holds the call, sends it
 * again inside its replay window. The mark never reaches a client.
 */
export const controllerUnsentHeader = "X-Signalbox-Controller-Unsent";

/**
 * Set only by the entry on its re-send of a call the controller answered unsent: that attempt's
 * request id, so the controller records the re-send under it and the two count as one request.
 */
export const unsentAttemptHeader = "X-Signalbox-Unsent-Attempt";

const attemptId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The refused attempt's id a header names, or nothing when it names none in its closed form. */
export function unsentAttempt(value: string | null) {
  return value !== null && attemptId.test(value) ? value : undefined;
}

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

/**
 * The controller's answer to a call that ran nowhere, under the id its terminal start was written
 * with, and its one log line. Every field is closed: the endpoint's trace id, step and reason when
 * the runtime refused, and the forward's guard and cause, which say where it stopped when it didn't.
 */
export function unsentAnswer(
  request: Request,
  requestId: string,
  diagnostic: Pick<
    GatewayFailureDiagnostic,
    "runtimeStep" | "runtimeReason" | "runtimeEndpointRequestId" | "guard" | "cause"
  >,
  resent = false,
) {
  console.error(
    "POOL_CONTROLLER_UNSENT",
    JSON.stringify({
      requestId,
      endpointRequestId: diagnostic.runtimeEndpointRequestId ?? null,
      step: diagnostic.runtimeStep ?? null,
      reason: diagnostic.runtimeReason ?? null,
      guard: diagnostic.guard,
      cause: diagnostic.cause,
      ...(resent ? { resent: true } : {}),
    }),
  );
  const refused = unsentRefusal(request);
  refused.headers.set("X-Request-Id", requestId);
  return refused;
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

const poolOnly = [
  controllerUnsentHeader,
  codeHandoverHeader,
  "X-Signalbox-Runtime-Failure-Step",
  "X-Signalbox-Runtime-Failure-Reason",
  "X-Signalbox-Runtime-Failure-Cause",
  "X-Signalbox-Runtime-Defect",
];

/**
 * A container's own answer can't speak for the pool. Its refusal steps, handover mark and unsent
 * mark are removed where it enters the pool, so only the endpoint itself can prove a call unsent.
 */
export function containerAnswer(response: Response) {
  if (response.status === 101 || !poolOnly.some((name) => response.headers.has(name)))
    return response;
  const headers = new Headers(response.headers);
  for (const name of poolOnly) headers.delete(name);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
