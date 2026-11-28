/** Which caller's read was refused; observe() names it on the way out. */
export type ObservationRead =
  | "launch"
  | "attested"
  | "configure"
  | "retire"
  | "root_retire"
  | "recovery"
  | "provider_observe";
const siblingStates = [
  "provisioning",
  "failed",
  "stopping",
  "stopped",
  "unhealthy",
  "unknown",
] as const;
type SiblingState = (typeof siblingStates)[number] | "other";
export const siblingState = (state: string): SiblingState =>
  siblingStates.find((value) => value === state) ?? "other";
/**
 * Why an observation was refused, as closed values only: never message text, never an id. An HTTP
 * answer keeps its status, a pin its field, an unsettled sibling its state.
 */
export type ObservationRefusal =
  | { reason: "read_status"; status: number }
  | {
      reason: "mismatch";
      field: "account" | "application" | "version" | "namespace" | "image" | "settings";
    }
  | { reason: "sibling_unsettled"; state: SiblingState }
  | {
      reason:
        | "credential_unavailable"
        | "credential_refused"
        | "fetch_failed"
        | "body_too_large"
        | "envelope_error"
        | "decode_failed"
        | "rollout_active"
        | "instance_not_running"
        | "changed_between_reads"
        | "slow"
        | "target_invalid";
    };
export class ProviderObservationRefused extends Error {
  readonly status = "unknown";
  readonly code: "provider_observation_refused" | "provider_fetch_failed";
  readonly refusal: ObservationRefusal;
  read?: ObservationRead;
  constructor(refusal: ObservationRefusal) {
    super("Pool provider observation refused");
    this.refusal = refusal;
    this.code =
      refusal.reason === "fetch_failed" ? "provider_fetch_failed" : "provider_observation_refused";
  }
}
/** A state outside the documented list: never absent, never proof, and named on its own. */
export class UndocumentedInstanceState extends ProviderObservationRefused {}
/** No credential, or one the provider refuses: nothing reads it again until a person acts. */
export class ProviderCredentialRefused extends ProviderObservationRefused {
  constructor() {
    super({ reason: "credential_refused" });
  }
}
export const refused = (refusal: ObservationRefusal) => new ProviderObservationRefused(refusal);
/** Anything a decode or parse threw becomes a closed refusal; our own refusals pass unchanged. */
export function closed(error: unknown, otherwise: ObservationRefusal) {
  return error instanceof ProviderObservationRefused ? error : refused(otherwise);
}
