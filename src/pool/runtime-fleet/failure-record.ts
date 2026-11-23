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
  path: Schema.Literals(["forward", "stream", "health", "install"]),
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
  // Pools whose current policy could not be installed on the cell: it serves no call until each is.
  policyOwed: Schema.optional(Schema.Array(Schema.String)),
  // The revision owed for each such pool: only an install of it or a newer one settles the debt.
  owedRevision: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
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
  options: { path?: "health" | "install"; owe?: { pool: string; revision: number } } = {},
): { suspect: FleetSuspect } | { quarantine: FleetFailure } {
  const path = options.path ?? "health";
  const counted = !lateCauses.has(read.cause);
  const since = current?.since ?? read.at;
  const reads = [...(current?.reads ?? []), read].slice(-keptReads);
  const failed = current?.failed;
  if (counted && failed && read.at - failed.at >= failedApartMs)
    return { quarantine: { path, rule: "failed_twice", reads: [failed, read] } };
  if (read.at - since >= unprovenMs)
    return {
      quarantine: {
        path,
        rule: "unproven",
        reads: failed && !reads.includes(failed) ? [failed, ...reads] : reads,
      },
    };
  const first = failed ?? (counted ? read : undefined);
  const owe = options.owe;
  const owed = [...new Set([...(current?.policyOwed ?? []), ...(owe ? [owe.pool] : [])])];
  const revisions = {
    ...current?.owedRevision,
    ...(owe ? { [owe.pool]: Math.max(owe.revision, current?.owedRevision?.[owe.pool] ?? 0) } : {}),
  };
  return {
    suspect: {
      since,
      ...(first ? { failed: first } : {}),
      reads,
      ...(owed.length ? { policyOwed: owed, owedRevision: revisions } : {}),
    },
  };
}

/**
 * The same suspect record once an install of `revision` for `pool` reached the cell, or nothing
 * when the cell owes a newer one: an older install landing late never settles a newer debt.
 */
export function policyInstalled(
  current: FleetSuspect,
  pool: string,
  revision: number,
): FleetSuspect | undefined {
  if (!current.policyOwed?.includes(pool)) return undefined;
  if (revision < (current.owedRevision?.[pool] ?? 0)) return undefined;
  const { policyOwed, owedRevision, ...rest } = current;
  const owed = (policyOwed ?? []).filter((value) => value !== pool);
  const { [pool]: _settled, ...revisions } = owedRevision ?? {};
  return owed.length ? { ...rest, policyOwed: owed, owedRevision: revisions } : rest;
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
const routerChecks = new Set<string>(["slot_health", "slot_protection"]);
const endpointChecks = new Set<string>(["endpoint_health", "endpoint_identity"]);
// The endpoint's keep-alive shares its step; only a readiness answer is a health read there.
const healthCauses = new Set<string>([
  "slot_unhealthy",
  "unhealthy",
  "timeout",
  "lease_elapsed",
  "protection_lease_too_short",
  "protection_lease_expired",
]);
export function failureBeforeSend(read: FleetFailureRead) {
  return (
    routerChecks.has(read.step) || (endpointChecks.has(read.step) && healthCauses.has(read.cause))
  );
}
