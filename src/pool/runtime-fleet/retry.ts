import { Schema } from "effect";
import { RemoteRuntimeDefect } from "../runtime-slots/request-error.ts";
import {
  runtimeFailureDiagnostic,
  runtimeFailureHeaders,
  runtimeRouteDiagnostic,
} from "../runtime-route-diagnostic.ts";
import { awaitProbe } from "../availability.ts";
import { FleetRefused } from "./state.ts";
import { runtimeRecoveryBudgetMs } from "../runtime-slots/recovery.ts";
import { nativeRuntimeUnavailable, nativeRuntimeStream } from "../runtime-unavailable.ts";
import { reachedNoContainer, unsentRefusal } from "../controller-unsent.ts";
import {
  modelCallReplayable,
  upstreamOutcomeUnknown,
} from "../../../clients/contracts/model-error.ts";
import { retainEndpointRequestId } from "./endpoint-trace.ts";

const safeReads = new Set(["/v1/models", "/typesafe/v1/models"]);
// Readiness or the policy lease is not current yet: the container's readiness said unhealthy or
// answered too late, a lease ran out, or the container is stopped and recovery will restart it.
// These wait. Fenced, deselected and policy refusals throw at once; a replaced boot or an endpoint
// that does not answer keeps the unpaced six-attempt budget. Only a selected runtime's admission
// remembers its step and reason; the legacy lifecycle path keeps its bounded retries unchanged.
const notAdmittingYet = new Set([
  "unhealthy",
  "slot_unhealthy",
  "protection_lease_expired",
  "protection_lease_too_short",
]);
function waitsForAdmission(error: unknown) {
  const diagnostic = runtimeRouteDiagnostic(error);
  return (
    !!diagnostic &&
    (notAdmittingYet.has(diagnostic.runtimeReason) ||
      (diagnostic.runtimeReason === "timeout" && diagnostic.runtimeStep === "endpoint_health"))
  );
}
/** How long an undispatched request waits for admission before the retryable 503. */
export const runtimeAdmissionWaitMs = 30_000;
const admissionPace = (waits: number) => Math.min(1_000, 125 * 2 ** waits);
export interface RetryTiming {
  now(): number;
  pause(milliseconds: number, signal: AbortSignal): Promise<void>;
}
const realTiming: RetryTiming = {
  // Monotonic, so tests and callers that move Date.now cannot stretch the wait.
  now: () => performance.now(),
  pause: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      // Jitter keeps requests that failed together from polling readiness in lockstep.
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", stop);
          resolve();
        },
        milliseconds * (0.8 + Math.random() * 0.4),
      );
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }),
};
function recoverable(error: unknown) {
  if (
    !(error instanceof Error) ||
    Schema.isSchemaError(error) ||
    error instanceof RemoteRuntimeDefect
  )
    return false;
  const { runtimeReason } = runtimeFailureDiagnostic(error, "fleet_forward");
  return (
    runtimeReason !== "aborted" &&
    runtimeReason !== "slot_policy" &&
    runtimeReason !== "slot_selection"
  );
}

/**
 * A runtime that crashed after accepting a call leaves its outcome unknown. A POST off the shared
 * allow-list may have started a paid job, so it keeps the cautious answer and its client decides;
 * everything else, including a job status read, is told to retry. Both keep the step and reason
 * that join the client's request id to the endpoint trace.
 */
function acceptedCrash(request: Request, error: unknown) {
  const pathname = new URL(request.url).pathname;
  // Model sockets are GET; an upgrade header on a POST must not exempt a job from this answer.
  if (request.method !== "POST" || modelCallReplayable(pathname))
    return nativeRuntimeUnavailable(request, error);
  const response = upstreamOutcomeUnknown(undefined, pathname);
  for (const [name, value] of Object.entries(runtimeFailureHeaders(error, "fleet_forward")))
    response.headers.set(name, value);
  if (error instanceof Error) retainEndpointRequestId(error, response);
  return response;
}

/** Only undispatched requests and explicit model-list reads may cross the crash boundary. */
export async function forwardRecoverably(
  request: Request,
  attempt: (request: Request, dispatched: () => void) => Promise<Response>,
  beforeDispatch: () => void,
  recover?: () => Promise<void>,
  timing: RetryTiming = realTiming,
) {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Runtime recovery deadline", "TimeoutError")),
    runtimeRecoveryBudgetMs,
  );
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  const safe =
    request.method === "GET" &&
    safeReads.has(new URL(request.url).pathname) &&
    !request.headers.has("upgrade");
  let retained = new Request(request, { signal });
  let recovered = false;
  let retainedOwned = true;
  let failure: unknown;
  let failures = 0;
  let refusals = 0;
  let waits = 0;
  let waitingSince: number | undefined;
  // Recovery is advisory. It declines to restart a runtime that is still running, and may fail for
  // other reasons; the request's own next admission re-checks selection, fence, policy and health.
  const tryRecovery = async () => {
    recovered = true;
    try {
      await awaitProbe(recover!, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(
        "POOL_RUNTIME_RECOVERY_DECLINED",
        runtimeFailureDiagnostic(error, "fleet_forward"),
      );
    }
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const current = retained;
      // Keep a body copy only until the send boundary; never retain an accepted upload for replay.
      let backup = current.body ? current.clone() : undefined;
      let dispatched = false;
      try {
        const response = await awaitProbe(
          () =>
            attempt(current, () => {
              dispatched = true;
              retainedOwned = false;
              if (!safe) clearTimeout(timer);
              if (backup) {
                void backup.body?.cancel().catch(() => {});
                backup = undefined;
              }
              beforeDispatch();
            }),
          signal,
        );
        if (backup) void backup.body?.cancel().catch(() => {});
        return nativeRuntimeStream(response, request);
      } catch (error) {
        failure = error;
        if (!dispatched) void current.body?.cancel().catch(() => {});
        if (signal.aborted || !recoverable(error)) {
          if (backup) void backup.body?.cancel().catch(() => {});
          throw error;
        }
        // The runtime's endpoint refused before its container send: nothing ran, so the entry may
        // send the call it holds once more.
        if (dispatched && !safe && reachedNoContainer(error)) return unsentRefusal(request, error);
        if (dispatched && !safe) return acceptedCrash(request, error);
        retained = backup ?? new Request(request, { signal });
        retainedOwned = true;
        if (error instanceof FleetRefused && error.reason === "capacity") {
          if (recovered || !recover) return nativeRuntimeUnavailable(request, error);
          await tryRecovery();
        }
        const waiting = waitsForAdmission(error);
        if (waiting) {
          waitingSince ??= timing.now();
          if (timing.now() - waitingSince >= runtimeAdmissionWaitMs) break;
          // Six hard refusals in a row end the request; a soft one in between restarts the count.
          refusals = 0;
        } else if (++refusals >= 6) break;
        if (++failures === 5 && !recovered && recover) {
          // A restart that finished is used at once; a declined one is followed by the next read.
          await tryRecovery();
          continue;
        }
        if (waiting) await timing.pause(admissionPace(waits++), signal);
      }
    }
    return nativeRuntimeUnavailable(request, failure);
  } catch (error) {
    if (deadline.signal.aborted && !request.signal.aborted)
      return nativeRuntimeUnavailable(request, error);
    throw error;
  } finally {
    clearTimeout(timer);
    if (retainedOwned) void retained.body?.cancel().catch(() => {});
  }
}
