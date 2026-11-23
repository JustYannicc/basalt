import { Schema } from "effect";
import { runtimeFailureDiagnostic, runtimeRouteDiagnostic } from "./runtime-route-diagnostic.ts";
import { ProviderObservationRefused } from "./runtime-provider/read.ts";
import { PoolDependencyFailure } from "./dependency-failure.ts";
import { ControlFailure, poolFailureDiagnostic } from "./json.ts";
import { RemoteRuntimeDefect } from "./runtime-slots/request-error.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";

/** A closed class name, decided by type rather than read off the error, so minifying keeps it. */
export function errorClass(error: unknown) {
  if (error instanceof SlotRefused) return "SlotRefused";
  if (error instanceof RemoteRuntimeDefect) return "RemoteRuntimeDefect";
  if (error instanceof ProviderObservationRefused) return "ProviderObservationRefused";
  if (error instanceof PoolDependencyFailure) return "PoolDependencyFailure";
  if (error instanceof ControlFailure) return "ControlFailure";
  if (Schema.isSchemaError(error)) return "SchemaError";
  if (error instanceof DOMException) return error.name === "TimeoutError" ? "Timeout" : "Abort";
  return error instanceof Error ? "Error" : "other";
}

/**
 * Closed fields for a line that reports a failed background pass, never the error's text: a pass
 * that fails every 2 s for hours must say why each time.
 */
export function pendingFields(error: unknown) {
  const remembered = runtimeRouteDiagnostic(error);
  return {
    reason: runtimeFailureDiagnostic(error, "slot_health").runtimeReason,
    ...(remembered ? { step: remembered.runtimeStep } : {}),
    class: errorClass(error),
    ...(error instanceof ProviderObservationRefused ? { provider: error.code } : {}),
    ...(error instanceof PoolDependencyFailure ? { dependency: error.dependency } : {}),
    ...(error instanceof ControlFailure ? { control: error.code } : {}),
    ...poolFailureDiagnostic(error),
  };
}
