import { Schema } from "effect";
import { RemoteRuntimeDefect } from "../runtime-slots/request-error.ts";
import { runtimeFailureDiagnostic } from "../runtime-route-diagnostic.ts";
import { awaitProbe } from "../availability.ts";
import { FleetRefused } from "./state.ts";
import { runtimeRecoveryBudgetMs } from "../runtime-slots/recovery.ts";
import { nativeRuntimeUnavailable, nativeRuntimeStream } from "../runtime-unavailable.ts";

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
        if (signal.aborted || !recoverable(error)) {
          if (backup) void backup.body?.cancel().catch(() => {});
          throw error;
        }
        if (dispatched && !safe) return nativeRuntimeUnavailable(request);
        retained = backup ?? new Request(request, { signal });
        if (error instanceof FleetRefused && error.reason === "capacity") {
          if (recovered || !recover) return nativeRuntimeUnavailable(request);
          recovered = true;
          await awaitProbe(recover, signal);
        }
        if (index === 4 && !recovered && recover) {
          recovered = true;
          await awaitProbe(recover, signal);
        }
      }
    }
    void retained.body?.cancel().catch(() => {});
    return nativeRuntimeUnavailable(request);
  } catch (error) {
    if (deadline.signal.aborted && !request.signal.aborted)
      return nativeRuntimeUnavailable(request);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
