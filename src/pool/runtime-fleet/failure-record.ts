import { Schema } from "effect";
import {
  runtimeFailureDiagnostic,
  runtimeReasons,
  runtimeSteps,
  type RuntimeRouteDiagnostic,
} from "../runtime-route-diagnostic.ts";
import { HealthLeaseElapsed } from "../runtime-slots/contract.ts";

/**
 * One failed read or call against a cell, as closed values only: where it failed and why. A health
 * answer slower than the lease it reported is `lease_elapsed`, a read the 2 s bound cut is
 * `timeout`; both carry the measured round trip, and the lease case the lease left on arrival.
 */
export const FleetFailureRead = Schema.Struct({
  at: Schema.Number,
  step: Schema.Literals(runtimeSteps),
  cause: Schema.Literals([...runtimeReasons, "lease_elapsed"]),
  roundTripMs: Schema.optional(Schema.Number),
  leaseLeftMs: Schema.optional(Schema.Number),
});
export type FleetFailureRead = typeof FleetFailureRead.Type;
/** Why a cell was quarantined: the path that saw it, and every read that counted. */
export const FleetFailure = Schema.Struct({
  path: Schema.Literals(["forward", "stream", "health"]),
  reads: Schema.Array(FleetFailureRead),
});
export type FleetFailure = typeof FleetFailure.Type;

const isRead = Schema.is(FleetFailureRead);
const isFailure = Schema.is(FleetFailure);
/** Rows carry these opaquely, so a value from another version is dropped, never a failed decode. */
export const readFailureRead = (value: unknown) => (isRead(value) ? value : undefined);
export const readFailure = (value: unknown) => (isFailure(value) ? value : undefined);

export function failureRead(
  error: unknown,
  step: RuntimeRouteDiagnostic["runtimeStep"],
  at: number,
  roundTripMs?: number,
): FleetFailureRead {
  const diagnostic = runtimeFailureDiagnostic(error, step);
  if (error instanceof HealthLeaseElapsed)
    return {
      at,
      step: diagnostic.runtimeStep,
      cause: "lease_elapsed",
      roundTripMs: error.roundTripMs,
      leaseLeftMs: error.leaseMs - error.roundTripMs,
    };
  return {
    at,
    step: diagnostic.runtimeStep,
    cause: diagnostic.runtimeReason,
    ...(roundTripMs === undefined ? {} : { roundTripMs: Math.round(roundTripMs) }),
  };
}

/** Failures that say nothing about the runtime: the caller left, or another layer refused. */
export function failureIgnored(read: FleetFailureRead) {
  return (
    read.cause === "aborted" ||
    read.cause === "slot_policy" ||
    read.step === "slot_authorize" ||
    // The front layer failed, not the runtime: only resumability is lost.
    read.step === "resume_layer"
  );
}

/** A read that reached another process or launch than the row's: never a transient. */
export function failureMismatch(read: FleetFailureRead) {
  return read.cause === "slot_identity" || read.cause === "fleet_identity";
}
