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
import { restartStartBoundMs } from "../runtime-slots/forced-restart-timing.ts";
import { nativeRuntimeUnavailable, nativeRuntimeStream } from "../runtime-unavailable.ts";
import { reachedNoContainer, unsentRefusal } from "../controller-unsent.ts";
import {
  modelCallReplayable,
  upstreamOutcomeUnknown,
} from "../../../clients/contracts/model-error.ts";
import { retainEndpointRequestId } from "./endpoint-trace.ts";

const safeReads = new Set(["/v1/models", "/typesafe/v1/models"]);
/** The model catalog: the only read the fleet sends again after any failure, never a socket. */
export const fleetSafeRead = (request: Request) =>
  request.method === "GET" &&
  safeReads.has(new URL(request.url).pathname) &&
  !request.headers.has("upgrade");
// Readiness or the policy lease is not current yet: the container's readiness said unhealthy or
// answered too late, a lease ran out, or the container is stopped and recovery will restart it.
// These wait. Fenced, deselected and policy refusals throw at once; a replaced boot or an endpoint
// that does not answer keeps the unpaced six-attempt budget, unless it is the root's restart that a
// call holds for (`restartRefusal`). Only a selected runtime's admission remembers its step and
// reason; the legacy lifecycle path keeps its bounded retries unchanged.
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
const paceCapMs = 1_000;
const admissionPace = (waits: number) => Math.min(paceCapMs, 125 * 2 ** waits);
/**
 * A held call's deadline sits this far past the end of the root recovery's bound: beyond one
 * jittered pause and one health read, so the call's own next attempt answers first, and the
 * deadline only ends an attempt that hangs.
 */
const holdBackstopMs = 5_000;
// What a root's restart shows a call before its new boot is selected: the old boot's record is
// gone (`slot_identity`), or the endpoint's start found no container to start.
function restartRefusal(error: unknown) {
  const { runtimeStep, runtimeReason } = runtimeFailureDiagnostic(error, "fleet_forward");
  return (
    runtimeReason === "slot_identity" ||
    (runtimeStep === "endpoint_route" && runtimeReason === "transport")
  );
}
export interface RetryTiming {
  now(): number;
  pause(milliseconds: number, signal: AbortSignal): Promise<void>;
}
interface RetryOptions {
  timing?: RetryTiming;
  /**
   * What is left of the bound of the root's recovery in progress; 0 when none is, or when a ready
   * cell can take the call. While it lasts, the call waits for that restart instead of failing.
   */
  rootHoldMs?(): Promise<number>;
  /**
   * The same for a cold fleet, a cell starting while none is ready (`RuntimeFleet.coldHoldMs`), and
   * below 0 when nothing can become ready, so a call it held has today's answer at once.
   */
  coldHoldMs?(): Promise<number>;
  /** Whether a code handover drains: nothing waits then, since a waiting call would hold it. */
  handover?(): boolean;
}
const capped = new WeakMap<Response, number>();
/** The root fallback cap's refusal, and the pace a call held for the root's restart waits it out at. */
export function markRootFallbackCap(response: Response, paceMs: number) {
  capped.set(response, paceMs);
  return response;
}
/** The waits between attempts; tests replace them instead of sleeping. */
export const runtimeRetryTiming: RetryTiming = {
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
  const { runtimeReason, runtimeStep } = runtimeFailureDiagnostic(error, "fleet_forward");
  return (
    // A failed front layer never starts a runtime recovery; the call gets the retryable answer.
    runtimeStep !== "resume_layer" &&
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
  { timing = runtimeRetryTiming, rootHoldMs, coldHoldMs, handover }: RetryOptions = {},
) {
  const deadline = new AbortController();
  const expire = () =>
    deadline.abort(new DOMException("Runtime recovery deadline", "TimeoutError"));
  let timer = setTimeout(expire, runtimeRecoveryBudgetMs);
  let expiresAt = timing.now() + runtimeRecoveryBudgetMs;
  // A call held for the root's restart is never ended by this deadline inside the recovery's bound.
  const holdUntil = (holdMs: number) => {
    const until = timing.now() + holdMs + holdBackstopMs;
    if (until <= expiresAt) return;
    clearTimeout(timer);
    expiresAt = until;
    timer = setTimeout(expire, until - timing.now());
  };
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  const safe = fleetSafeRead(request);
  let retained = new Request(request, { signal });
  let recovered = false;
  let retainedOwned = true;
  let failure: unknown;
  let failures = 0;
  let refusals = 0;
  let waits = 0;
  let waitingSince: number | undefined;
  // Where the hold last in force ends, on this clock; a cap refusal is waited out until then.
  let holdEndsAt = -Infinity;
  // A call holds at most one start bound in all, whatever it waits for and however often.
  let firstHeldAt: number | undefined;
  let held = false;
  // Whether a cold start is what holds the call, so its stand-down ends the cap waits too; the cap
  // waits a root recovery gave the call stay until that recovery's own end.
  let heldCold = false;
  let rootHoldEndsAt = -Infinity;
  let kicked = false;
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
      // The hold in force when an attempt begins judges it, whatever the hold reads once it fails.
      const root = rootHoldMs && !handover?.() ? await rootHoldMs().catch(() => 0) : 0;
      const cold = coldHoldMs && !handover?.() ? await coldHoldMs().catch(() => 0) : 0;
      const read = Math.max(root, cold);
      if (read > 0) firstHeldAt ??= timing.now();
      const holdMs =
        read <= 0
          ? 0
          : firstHeldAt === undefined
            ? read
            : Math.max(0, Math.min(read, firstHeldAt + restartStartBoundMs - timing.now()));
      if (root > 0)
        rootHoldEndsAt = Math.max(rootHoldEndsAt, timing.now() + Math.min(root, holdMs));
      if (holdMs > 0) {
        held = true;
        heldCold = cold > root;
        holdEndsAt = timing.now() + holdMs;
      } else if (held) {
        held = kicked = false;
        // A hold that ends before its bound (the root serves, or recovery stands down) leaves the
        // call today's rules from now on; one that reaches it has had its wait. A handover ends it
        // on the call's own history instead, so the drain is never longer than it was without holds.
        // When nothing can become ready for a cold start, the call has today's answer now, cap waits
        // included.
        if (heldCold && cold < 0) holdEndsAt = rootHoldEndsAt;
        else if (timing.now() < holdEndsAt - paceCapMs && !handover?.()) {
          waitingSince = undefined;
          refusals = failures = 0;
          recovered = false;
        }
      }
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
        const capPace = dispatched ? undefined : capped.get(response);
        // Inside a hold's bound the cap's refusal is waited out at the cap's rate: the calls a
        // restart releases together would otherwise lose the ones past its burst.
        if (capPace !== undefined && timing.now() < holdEndsAt && !handover?.()) {
          void response.body?.cancel().catch(() => {});
          void current.body?.cancel().catch(() => {});
          retained = backup ?? new Request(request, { signal });
          // A hold longer than the call's own deadline is never ended by it while the cap is waited out.
          holdUntil(holdEndsAt - timing.now());
          await timing.pause(capPace, signal);
          continue;
        }
        if (backup) void backup.body?.cancel().catch(() => {});
        return nativeRuntimeStream(response, request);
      } catch (error) {
        failure = error;
        if (!dispatched) void current.body?.cancel().catch(() => {});
        // Only a call that never left waits on the root's restart.
        const holdable = dispatched ? 0 : holdMs;
        const restarting = holdable > 0 && restartRefusal(error);
        if (signal.aborted || !(restarting || recoverable(error))) {
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
        const waiting = restarting || waitsForAdmission(error);
        // While the root's recovery is inside its bound, the call waits for it, not for 30 s.
        const holding = waiting && holdable > 0;
        if (waiting) {
          waitingSince ??= timing.now();
          if (!holding && timing.now() - waitingSince >= runtimeAdmissionWaitMs) break;
          // Six hard refusals in a row end the request; a wait in between restarts the count.
          refusals = 0;
        } else if (++refusals >= 6) break;
        if (holding) {
          holdUntil(holdable);
          // Once a hold, as a call joins recovery once today, but not awaited: a pass can outlast the
          // bound. It keeps recovery going should its alarm chain break while calls wait for it.
          if (recover && !kicked) {
            kicked = true;
            void Promise.resolve()
              .then(recover)
              .catch(() => {});
          }
        }
        // A held call's recovery runs on its own cadence already; joining one of its passes could
        // keep the call past the bound.
        if (++failures === 5 && !recovered && recover && !holding) {
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
