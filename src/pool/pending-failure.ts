import { Schema } from "effect";
import { runtimeFailureDiagnostic, runtimeRouteDiagnostic } from "./runtime-route-diagnostic.ts";
import {
  ProviderObservationRefused,
  type ObservationRead,
  type ObservationRefusal,
} from "./runtime-provider/read.ts";
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

/** Each one is absent for any error but a provider refusal. */
interface ProviderFields {
  provider?: ProviderObservationRefused["code"];
  read?: ObservationRead | null;
  reason?: ObservationRefusal["reason"];
  status?: number;
  field?: Extract<ObservationRefusal, { field: unknown }>["field"];
}
/**
 * A provider refusal's own closed fields, which its class alone doesn't say: its code, the read it
 * refused, and why, with the status or pin behind that. Spread after a derived reason, its reason
 * replaces one that for a provider refusal only ever says transport.
 */
export function providerFields(error: unknown): ProviderFields {
  if (!(error instanceof ProviderObservationRefused)) return {};
  const refusal = error.refusal;
  return {
    provider: error.code,
    read: error.read ?? null,
    reason: refusal.reason,
    ...("status" in refusal ? { status: refusal.status } : {}),
    ...("field" in refusal ? { field: refusal.field } : {}),
  };
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
    ...providerFields(error),
    ...(error instanceof PoolDependencyFailure ? { dependency: error.dependency } : {}),
    ...(error instanceof ControlFailure ? { control: error.code } : {}),
    ...poolFailureDiagnostic(error),
  };
}
