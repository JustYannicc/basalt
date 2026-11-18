import { Schema } from "effect";
import { RemoteRuntimeDefect } from "../runtime-slots/request-error.ts";
import { runtimeFailureDiagnostic } from "../runtime-route-diagnostic.ts";
import { awaitProbe } from "../availability.ts";
import { FleetRefused } from "./state.ts";
import { runtimeRecoveryBudgetMs } from "../runtime-slots/recovery.ts";
import { nativeRuntimeUnavailable, nativeRuntimeStream } from "../runtime-unavailable.ts";

const safeReads = new Set(["/v1/models", "/typesafe/v1/models"]);
// The runtime answered but cannot admit yet: its readiness or policy lease is not current. Only
// these wait; a gone, replaced or fenced runtime keeps its immediate refusal or retry budget.
const notAdmittingYet = new Set([
  "unhealthy",
  "slot_unhealthy",
  "protection_lease_expired",
  "protection_lease_too_short",
]);
/** How long an undispatched request waits for a live runtime to admit it before a retryable 503. */
export const runtimeAdmissionWaitMs = 30_000;
const admissionPace = (waits: number) => Math.min(1_000, 125 * 2 ** waits);
export interface RetryTiming {
  now(): number;
  pause(milliseconds: number): Promise<void>;
}
const realTiming: RetryTiming = {
  now: () => Date.now(),
  pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
  // Recovery may find the runtime still running and decline to restart it. That is not the
  // request's refusal: the request's own next admission decides, inside its wait.
  const tryRecovery = async () => {
    recovered = true;
    try {
      await awaitProbe(recover!, signal);
    } catch (error) {
      if (signal.aborted) throw error;
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
        if (dispatched && !safe) return nativeRuntimeUnavailable(request, error);
        retained = backup ?? new Request(request, { signal });
        retainedOwned = true;
        if (error instanceof FleetRefused && error.reason === "capacity") {
          if (recovered || !recover) return nativeRuntimeUnavailable(request, error);
          await tryRecovery();
        }
        const waiting = notAdmittingYet.has(
          runtimeFailureDiagnostic(error, "fleet_forward").runtimeReason,
        );
        if (waiting) {
          waitingSince ??= timing.now();
          if (timing.now() - waitingSince >= runtimeAdmissionWaitMs) break;
        } else if (++refusals >= 6) break;
        if (++failures === 5 && !recovered && recover) await tryRecovery();
        if (waiting) await awaitProbe(() => timing.pause(admissionPace(waits++)), signal);
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
