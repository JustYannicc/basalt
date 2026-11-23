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
/**
 * Why a cell was quarantined: the path that saw it, the rule that fired (hard evidence, two failed
 * reads far enough apart, or no good read for too long), and every read that counted.
 */
export const FleetFailure = Schema.Struct({
  path: Schema.Literals(["forward", "stream", "health"]),
  rule: Schema.Literals(["evidence", "failed_twice", "unproven"]),
  reads: Schema.Array(FleetFailureRead),
});
export type FleetFailure = typeof FleetFailure.Type;
/**
 * A ready cell whose last read was not good: fenced until a good read. `since` is its first such
 * read, `failed` the first that counted as a failure, `reads` the latest few.
 */
export const FleetSuspect = Schema.Struct({
  since: Schema.Number,
  failed: Schema.optional(FleetFailureRead),
  reads: Schema.Array(FleetFailureRead),
});
export type FleetSuspect = typeof FleetSuspect.Type;

const isRead = Schema.is(FleetFailureRead);
const isFailure = Schema.is(FleetFailure);
const isSuspect = Schema.is(FleetSuspect);
/** Rows carry these opaquely, so a value from another version is dropped, never a failed decode. */
export const readFailureRead = (value: unknown) => (isRead(value) ? value : undefined);
export const readFailure = (value: unknown) => (isFailure(value) ? value : undefined);
export const readSuspect = (value: unknown) => (isSuspect(value) ? value : undefined);

/** A second failed read counts only this long after the first: #1441's refusal lasts 2 to 4 s. */
export const failedApartMs = 6_000;
/** A ready cell with no good read for this long is quarantined, however its reads failed. */
export const unprovenMs = 30_000;
const keptReads = 4;
/**
 * An answer that came back too late for the lease it carried, on either path: it fences, but
 * says only that the controller can't prove the lease now, so it never counts as a failed read.
 */
const lateCauses = new Set<string>([
  "lease_elapsed",
  "protection_lease_too_short",
  "protection_lease_expired",
]);

/**
 * The fleet's rule for a read that is not good, on a cell that may already be suspect:
 * - any read that is not good fences the cell until the next good read;
 * - hard evidence quarantines at once (handled by the caller), and two failed reads at least
 *   `failedApartMs` apart quarantine;
 * - `unprovenMs` without a good read quarantines.
 * A late answer (`lease_elapsed`) fences but never counts as a failed read.
 */
export function nextSuspect(
  current: FleetSuspect | undefined,
  read: FleetFailureRead,
): { suspect: FleetSuspect } | { quarantine: FleetFailure } {
  const counted = !lateCauses.has(read.cause);
  const since = current?.since ?? read.at;
  const reads = [...(current?.reads ?? []), read].slice(-keptReads);
  const failed = current?.failed;
  if (counted && failed && read.at - failed.at >= failedApartMs)
    return { quarantine: { path: "health", rule: "failed_twice", reads: [failed, read] } };
  if (read.at - since >= unprovenMs)
    return {
      quarantine: {
        path: "health",
        rule: "unproven",
        reads: failed && !reads.includes(failed) ? [failed, ...reads] : reads,
      },
    };
  const first = failed ?? (counted ? read : undefined);
  return { suspect: { since, ...(first ? { failed: first } : {}), reads } };
}

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
  return (
    read.cause === "slot_identity" ||
    read.cause === "fleet_identity" ||
    read.cause === "protection_boot_changed"
  );
}

/**
 * Health and lease checks before any byte reached the container: the router's own, and the
 * endpoint's last readiness read before its send. Nothing was sent, so each is a health read.
 */
const beforeSend = new Set<string>([
  "slot_health",
  "slot_protection",
  "endpoint_health",
  "endpoint_identity",
]);
export function failureBeforeSend(read: FleetFailureRead) {
  return beforeSend.has(read.step);
}
