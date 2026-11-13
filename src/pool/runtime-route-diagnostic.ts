import { SlotRefused } from "./runtime-slots/contract.ts";
import { FleetRefused } from "./runtime-fleet/state.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { ProtectionRefusal } from "./runtime-protection.ts";

const steps = [
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
export interface RuntimeRouteDiagnostic {
  runtimeStep: (typeof steps)[number];
  runtimeReason: (typeof reasons)[number];
}
const stepHeader = "X-Signalbox-Runtime-Failure-Step";
const reasonHeader = "X-Signalbox-Runtime-Failure-Reason";
// Preserve exception identity and existing refusal/replay handling; only closed metadata crosses the binding.
const observed = new WeakMap<object, RuntimeRouteDiagnostic>();
const object = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");
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
  return object(error) ? observed.get(error) : undefined;
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
export function runtimeFailureHeaders(error: unknown, step: RuntimeRouteDiagnostic["runtimeStep"]) {
  const diagnostic = runtimeRouteDiagnostic(error) ?? {
    runtimeStep: step,
    runtimeReason: reason(error),
  };
  return { [stepHeader]: diagnostic.runtimeStep, [reasonHeader]: diagnostic.runtimeReason };
}
export function retainRuntimeFailure(response: Response, error: object) {
  const runtimeStep = steps.find((value) => value === response.headers.get(stepHeader));
  const runtimeReason = reasons.find((value) => value === response.headers.get(reasonHeader));
  if (runtimeStep && runtimeReason) observed.set(error, { runtimeStep, runtimeReason });
  return error;
}
