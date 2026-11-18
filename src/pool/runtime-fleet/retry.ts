import { Schema } from "effect";
import { RemoteRuntimeDefect } from "../runtime-slots/request-error.ts";
import { runtimeFailureDiagnostic, runtimeFailureHeaders } from "../runtime-route-diagnostic.ts";
import { awaitProbe } from "../availability.ts";
import { FleetRefused } from "./state.ts";
import { runtimeRecoveryBudgetMs } from "../runtime-slots/recovery.ts";
import { nativeRuntimeUnavailable, nativeRuntimeStream } from "../runtime-unavailable.ts";
import {
  modelCallReplayable,
  upstreamOutcomeUnknown,
} from "../../../clients/contracts/model-error.ts";
import { retainEndpointRequestId } from "./endpoint-trace.ts";

const safeReads = new Set(["/v1/models", "/typesafe/v1/models"]);
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
  if (request.method !== "POST" || request.headers.has("upgrade") || modelCallReplayable(pathname))
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
  try {
    for (let index = 0; index < 6; index++) {
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
        if (dispatched && !safe) return acceptedCrash(request, error);
        retained = backup ?? new Request(request, { signal });
        retainedOwned = true;
        if (error instanceof FleetRefused && error.reason === "capacity") {
          if (recovered || !recover) return nativeRuntimeUnavailable(request, error);
          recovered = true;
          await awaitProbe(recover, signal);
        }
        if (index === 4 && !recovered && recover) {
          recovered = true;
          await awaitProbe(recover, signal);
        }
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
