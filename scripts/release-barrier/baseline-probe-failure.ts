import { baselineRoles, BaselineInventoryError, type BaselineProbeRow } from "./baseline-probe.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import {
  CandidateSettingsReadFailure,
  candidateReadFailure,
  candidateFailureDetails,
} from "./candidate-failure.ts";
import { BarrierRefusal } from "./refusal.ts";

/**
 * The probe's report rows when it fails before or instead of reading every role. A barrier refusal
 * (for example a malformed release-declarations.json) already names its closed reason, so it is
 * reported as itself rather than as a candidate inventory read failure.
 */
export function baselineProbeFailureRows(error: unknown, ms: number): BaselineProbeRow[] {
  const failure = safeProviderFailure(error);
  const unclassified = failure.type === "Error" || failure.type === "unknown";
  const refusal = error instanceof BarrierRefusal ? error : undefined;
  const candidate =
    error instanceof CandidateSettingsReadFailure
      ? error
      : !refusal && unclassified
        ? candidateReadFailure(error, "inventory")
        : undefined;
  return baselineRoles.map((role) => ({
    role,
    reason:
      error instanceof BaselineInventoryError
        ? error.refusals.map((item) => `${item.role}: ${item.reason}`).join("; ")
        : (refusal?.reason ?? candidate?.message ?? failure.reason ?? "inventory-read-failed"),
    ok: false,
    type:
      error instanceof BaselineInventoryError
        ? "BaselineInventoryError"
        : refusal && unclassified
          ? "BarrierRefusal"
          : (candidate?._tag ?? failure.type),
    ...(candidate ? { candidateFailure: candidateFailureDetails(candidate) } : {}),
    status: failure.status ?? null,
    bytes: 0,
    ms,
    attempts: 0,
  }));
}
