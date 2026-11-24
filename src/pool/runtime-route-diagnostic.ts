import { ContainerEnded, SlotRefused } from "./runtime-slots/contract.ts";
import { FleetRefused } from "./runtime-fleet/state.ts";
import { PoolRuntimeUnhealthy, PoolStartupDeadline } from "./lifecycle.ts";
import { ProtectionRefusal } from "./runtime-protection.ts";
import { PoolDependencyFailure } from "./dependency-failure.ts";
import { ControlFailure } from "./json.ts";
import {
  decodeReadySignals,
  runtimeReadySignals,
  withReadySignals,
} from "./runtime-ready-signals.ts";

const steps = [
  "primary_forward",
  "fleet_acquire",
  "fleet_identity",
  "fleet_forward",
  "fleet_release",
  "slot_authorize",
  "slot_selection",
  "slot_health",
  "slot_protection",
  "slot_pre_send",
  "slot_port",
  "endpoint_route",
  "endpoint_identity",
  "endpoint_admission",
  "endpoint_health",
  "endpoint_request",
  "port_lookup",
  "port_dispatch",
  // The container's front layer (#1642): its failure costs resumability, never the runtime.
  "resume_layer",
] as const;
const reasons = [
  "slot_identity",
  "slot_selection",
  "slot_policy",
  "slot_unhealthy",
  "slot_draining",
  "slot_uncertain",
  "fleet_capacity",
  "fleet_identity",
  "fleet_uncertain",
  "fleet_draining",
  "protection_lease_invalid",
  "protection_lease_expired",
  "protection_lease_too_short",
  "protection_boot_changed",
  "unhealthy",
  "timeout",
  "aborted",
  "transport",
  "unknown",
] as const;
export const runtimeSteps = steps;
export const runtimeReasons = reasons;
// A separate header, so callers on an older release still recognize every reason value.
const causes = [
  "startup_deadline",
  // The container's monitor recorded its exit: hard evidence, where "not running" alone is not.
  "container_ended",
  "control",
  "dependency_storage",
  "dependency_membership",
  "dependency_signing",
] as const;
export interface RuntimeRouteDiagnostic {
  runtimeStep: (typeof steps)[number];
  runtimeReason: (typeof reasons)[number];
  runtimeEndpointRequestId?: string;
}
const stepHeader = "X-Signalbox-Runtime-Failure-Step";
const reasonHeader = "X-Signalbox-Runtime-Failure-Reason";
const causeHeader = "X-Signalbox-Runtime-Failure-Cause";
// The readiness answer's signals as the sender decoded them; the receiver decodes them again.
const readyHeader = "X-Signalbox-Runtime-Failure-Ready";
// Every closed value together fits in 257 characters; anything much longer was never ours.
const readyHeaderLength = 1_024;
// Preserve exception identity and existing refusal/replay handling; only closed metadata crosses the binding.
const observed = new WeakMap<object, RuntimeRouteDiagnostic>();
const observedCauses = new WeakMap<object, (typeof causes)[number]>();
const correlations = new WeakMap<object, string>();
const object = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");
export function endpointRequestId(error: unknown) {
  return object(error) ? correlations.get(error) : undefined;
}
export function correlateEndpointRequest(value: object, requestId: string) {
  correlations.set(value, requestId);
}
export function retainEndpointRequestId(source: object, destination: object) {
  const id = correlations.get(source);
  if (id) correlations.set(destination, id);
}
/** The failed dependency or deadline behind a refusal, when one is known. */
export function runtimeFailureCause(error: unknown) {
  return cause(error);
}
function cause(error: unknown): (typeof causes)[number] | undefined {
  if (error instanceof PoolStartupDeadline) return "startup_deadline";
  if (error instanceof ContainerEnded) return "container_ended";
  if (error instanceof ControlFailure) return "control";
  if (error instanceof PoolDependencyFailure) return `dependency_${error.dependency}`;
  return object(error) ? observedCauses.get(error) : undefined;
}
function reason(error: unknown): RuntimeRouteDiagnostic["runtimeReason"] {
  if (error instanceof SlotRefused) return `slot_${error.reason}`;
  if (error instanceof FleetRefused) return `fleet_${error.reason}`;
  if (error instanceof ProtectionRefusal) return `protection_${error.reason}`;
  if (error instanceof PoolRuntimeUnhealthy) return "unhealthy";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return error instanceof Error ? "transport" : "unknown";
}
export function runtimeRouteDiagnostic(error: unknown) {
  const diagnostic = object(error) ? observed.get(error) : undefined;
  const requestId = endpointRequestId(error);
  return diagnostic && requestId
    ? { ...diagnostic, runtimeEndpointRequestId: requestId }
    : diagnostic;
}
export function rememberRuntimeFailure(
  step: RuntimeRouteDiagnostic["runtimeStep"],
  error: unknown,
) {
  if (object(error) && !observed.has(error))
    observed.set(error, { runtimeStep: step, runtimeReason: reason(error) });
}
export function refuseRuntime(step: RuntimeRouteDiagnostic["runtimeStep"], error: unknown): never {
  rememberRuntimeFailure(step, error);
  throw error;
}
export function runtimeFailureDiagnostic(
  error: unknown,
  step: RuntimeRouteDiagnostic["runtimeStep"],
) {
  const diagnostic = runtimeRouteDiagnostic(error) ?? {
    runtimeStep: step,
    runtimeReason: reason(error),
  };
  const requestId = endpointRequestId(error);
  return requestId ? { ...diagnostic, runtimeEndpointRequestId: requestId } : diagnostic;
}
export function runtimeFailureCode(diagnostic: RuntimeRouteDiagnostic) {
  return `runtime_${diagnostic.runtimeStep}_${diagnostic.runtimeReason}`;
}
/** Whether a reported code is one this module can emit; anything else is untrusted text. */
export function knownRuntimeFailureCode(code: string) {
  return steps.some((runtimeStep) =>
    reasons.some((runtimeReason) => code === runtimeFailureCode({ runtimeStep, runtimeReason })),
  );
}
export function runtimeFailureHeaders(error: unknown, step: RuntimeRouteDiagnostic["runtimeStep"]) {
  const diagnostic = runtimeFailureDiagnostic(error, step);
  const failureCause = cause(error);
  const ready = runtimeReadySignals(error);
  return {
    [stepHeader]: diagnostic.runtimeStep,
    [reasonHeader]: diagnostic.runtimeReason,
    ...(failureCause ? { [causeHeader]: failureCause } : {}),
    ...(ready ? { [readyHeader]: JSON.stringify(ready) } : {}),
  };
}
export function runtimeResponseDiagnostic(response: Response) {
  const runtimeStep = steps.find((value) => value === response.headers.get(stepHeader));
  const runtimeReason = reasons.find((value) => value === response.headers.get(reasonHeader));
  return runtimeStep && runtimeReason ? { runtimeStep, runtimeReason } : undefined;
}
export function runtimeResponseCause(response: Response) {
  return causes.find((value) => value === response.headers.get(causeHeader));
}
/** A header is never trusted: only what decodes into closed values again survives. */
export function runtimeResponseReady(response: Response) {
  const header = response.headers.get(readyHeader);
  if (header === null || header.length > readyHeaderLength) return undefined;
  try {
    return decodeReadySignals(JSON.parse(header));
  } catch {
    return undefined;
  }
}
/** One closed log field: the refusal code and, when known, the failed dependency or deadline. */
export function runtimeResponseRefusal(response: Response) {
  const diagnostic = runtimeResponseDiagnostic(response);
  if (!diagnostic) return undefined;
  const failureCause = runtimeResponseCause(response);
  return { code: runtimeFailureCode(diagnostic), ...(failureCause ? { cause: failureCause } : {}) };
}
export function stripRuntimeFailureHeaders(headers: Headers) {
  headers.delete(stepHeader);
  headers.delete(reasonHeader);
  headers.delete(causeHeader);
  headers.delete(readyHeader);
}
export function retainRuntimeFailure(response: Response, error: object) {
  retainEndpointRequestId(response, error);
  const diagnostic = runtimeResponseDiagnostic(response);
  if (diagnostic) observed.set(error, diagnostic);
  const failureCause = runtimeResponseCause(response);
  if (diagnostic && failureCause) observedCauses.set(error, failureCause);
  if (diagnostic) withReadySignals(error, runtimeResponseReady(response));
  return error;
}
