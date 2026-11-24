import {
  modelCallReplayable,
  upstreamOutcomeUnknown,
} from "../../clients/contracts/model-error.ts";
import { captureError } from "../telemetry/sentry.ts";
import { pageTemplate } from "../telemetry/privacy.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { awaitProbe } from "./availability.ts";
import { unavailableResponse } from "./json.ts";
import { isPublicModelPath } from "./lifecycle.ts";
import { endpointMetadata } from "./model-history/record.ts";
import { shape } from "./runtime-fleet/endpoint-trace.ts";
import { nativeRuntimeStream, nativeRuntimeUnavailable } from "./runtime-unavailable.ts";
import { handingOver } from "./code-handover.ts";
import {
  sentNowhere,
  unsentAttempt,
  unsentAttemptHeader,
  withoutUnsentMark,
} from "./controller-unsent.ts";
import { resumableAnswer, type StreamResumeInput } from "./stream-resume.ts";
import { heldBytes, holdBody, type HeldBody } from "./held-body.ts";
import { controllerIsolateHeader, isolate } from "./isolate.ts";
import { openRouterAttempt } from "./router-attempt.ts";

/** Clients reconnected 0.2-0.8 s after the 2026-11-18 reset, and retry advice already says 1 s. */
export const controllerReplayDelayMs = 1_000;
/** A model call's body is held, up to this size, only until the controller answers. */
export const controllerHoldBytes = 4 * 1024 * 1024;
/** A device call's signed assertion lives 25 s (token.ts); a later replay would be refused as stale. */
export const controllerReplayWindowMs = 20_000;
/**
 * Held copies in one isolate stay under a quarter of its 128 MB (the tee's own queue and the brief
 * join are not counted). Past it a call is forwarded unheld: it is only not replayable.
 */
export const controllerHoldBudgetBytes = 32 * 1024 * 1024;
/** Bytes held for replay in this isolate right now. */
export const controllerHeldBytes = heldBytes;

// The platform may end the controller instance at any time; this is its "reconnect or retry" error.
const instanceEnded = /\bDurable Object instance is no longer active\b/i;

/** The platform marks a stub error it advises retrying; an overloaded object must not be retried. */
function resetCause(error: unknown): "instance_ended" | "retryable" | undefined {
  if (!(error instanceof Error) || ("overloaded" in error && error.overloaded === true)) return;
  if (instanceEnded.test(error.message)) return "instance_ended";
  if ("retryable" in error && error.retryable === true) return "retryable";
}

export function controllerInstanceEnded(error: unknown): boolean {
  return resetCause(error) !== undefined;
}

export interface ControllerHop {
  /** Resolved per attempt: the platform says a stub that threw this error fails again at once. */
  controller(): {
    fetch(request: Request): Promise<Response>;
    resume?(input: StreamResumeInput): Promise<Response>;
  };
  env: SentryEnv;
  defer(work: Promise<unknown>): void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  holdBudgetBytes?: number;
  /** Verifies the router's name for a call, so the entry's isolate line carries that id. */
  signing?: { key: string; previous?: string };
}

type Outcome =
  | "replayed"
  | "replay_failed"
  | "retry_advised"
  | "surfaced"
  | "outcome_unknown"
  | "client_left"
  | "stream_ended";
type Reason =
  | "body_too_large"
  | "body_unreadable"
  | "hold_budget_full"
  | "not_replayable"
  | "too_late";

/** These reads write no request record, choose no account and reserve no usage in the controller. */
function safeRead(request: Request): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    !request.headers.has("upgrade") &&
    endpointMetadata(new URL(request.url).pathname).apiType !== "video-retrieve"
  );
}

/** Only an allow-listed model call costs no more than one response's tokens when sent twice. */
function replayableCall(request: Request): boolean {
  return (
    request.method === "POST" &&
    !request.headers.has("upgrade") &&
    modelCallReplayable(new URL(request.url).pathname)
  );
}

const endpointOf = (request: Request) => {
  const pathname = new URL(request.url).pathname;
  return endpointMetadata(pathname).endpoint ?? pageTemplate(pathname);
};

function report(
  hop: ControllerHop,
  request: Request,
  requestId: string,
  outcome: Outcome,
  error: unknown,
  reason?: Reason,
  saved = false,
) {
  const pathname = new URL(request.url).pathname;
  console.error(
    "POOL_CONTROLLER_INTERRUPTED",
    JSON.stringify({
      count: 1,
      requestId,
      outcome,
      saved,
      ...(reason ? { reason } : {}),
      cause: resetCause(error) ?? "transport",
      method: ["GET", "HEAD", "POST"].includes(request.method) ? request.method : "other",
      endpoint: endpointOf(request),
    }),
  );
  hop.defer(captureError(hop.env, "pool_controller_interrupted", pathname, undefined, requestId));
}

function retryAdvice(request: Request, requestId: string): Response {
  const response = isPublicModelPath(new URL(request.url).pathname)
    ? nativeRuntimeUnavailable(request)
    : unavailableResponse();
  response.headers.set("Retry-After", "1");
  response.headers.set("X-Request-Id", requestId);
  return response;
}

const sleep = (milliseconds: number, signal: AbortSignal) =>
  awaitProbe(() => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)), signal);

/**
 * Surviving a controller replacement. Before the first response byte, a safe read or an
 * allow-listed model call is sent once more to a new instance; one whose body was too large to
 * hold, or that fails again, gets the native retry advice its client follows. A call that starts a
 * job is never sent twice. A started stream is never replayed: it ends with the native retry
 * terminal. A control write keeps today's unknown-outcome failure.
 */
export async function fetchController(request: Request, hop: ControllerHop): Promise<Response> {
  // Only the entry's own re-send names a refused attempt; a client never chooses that id.
  if (request.headers.has(unsentAttemptHeader)) {
    const headers = new Headers(request.headers);
    headers.delete(unsentAttemptHeader);
    request = new Request(request, { headers });
  }
  const model = replayableCall(request);
  const requestId = crypto.randomUUID();
  const copy = holdBody(
    model && request.body ? request.clone().body : null,
    {
      maxBytes: controllerHoldBytes,
      budgetBytes: hop.holdBudgetBytes ?? controllerHoldBudgetBytes,
      windowMs: controllerReplayWindowMs,
    },
    () =>
      console.error(
        "POOL_CONTROLLER_HOLD_SKIPPED",
        JSON.stringify({
          count: 1,
          requestId,
          endpoint: endpointOf(request),
          heldBytes: controllerHeldBytes(),
        }),
      ),
  );
  const traced = request.method === "POST" && isPublicModelPath(new URL(request.url).pathname);
  const here = isolate();
  const named =
    traced && hop.signing
      ? await openRouterAttempt(request, hop.signing.key, hop.signing.previous)
      : undefined;
  // Written before the send, so a call its isolate takes down still has its line.
  if (traced)
    console.info("POOL_ENTRY_ISOLATE", {
      phase: "sent",
      requestId: named?.requestId ?? null,
      attempt: named?.attempt ?? null,
      entry: here.id,
      entryAgeMs: Date.now() - here.startedAt,
    });
  try {
    const response = await forwardHeld(request, hop, model, requestId, copy);
    const controller = response.headers.get(controllerIsolateHeader);
    if (controller === null) return response;
    console.info("POOL_ENTRY_ISOLATE", {
      phase: "answered",
      requestId: named?.requestId ?? null,
      entry: here.id,
      controller: /^[0-9a-f-]{36}$/.test(controller) ? controller : "invalid",
      shared: controller === here.id,
    });
    const headers = new Headers(response.headers);
    headers.delete(controllerIsolateHeader);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } finally {
    // Past the controller's answer, or any failure, the held copy can never be sent again.
    copy.release();
  }
}

const resendable = (response: Response) => handingOver(response) || sentNowhere(response);

/**
 * A controller handing over to new code refuses new model calls until it resets itself, and a call
 * whose runtime refused it before its container send comes back marked unsent. Either way the call
 * was never sent on, so a safe read or a held model call is sent again each second inside the
 * replay window, and once an answer comes the caller sees nothing. Past the window, or without a
 * held body, the refusal itself goes back: the retryable 503 clients already follow.
 */
async function awaitHandover(
  request: Request,
  hop: ControllerHop,
  model: boolean,
  copy: HeldBody,
  response: Response,
  begun: number,
): Promise<Response> {
  if (!resendable(response) || (!model && !safeRead(request))) return withoutUnsentMark(response);
  const now = hop.now ?? Date.now;
  const cause = handingOver(response) ? "handover" : "unsent";
  let sends = 0;
  // The first unsent answer names the attempt for every later re-send, a handover refusal between.
  let attempt: string | undefined;
  while (resendable(response)) {
    if (now() - begun + controllerReplayDelayMs > controllerReplayWindowMs) break;
    // A re-send of a call never sent names that attempt, so the controller records one request.
    attempt ??= sentNowhere(response)
      ? unsentAttempt(response.headers.get("X-Request-Id"))
      : undefined;
    const headers = new Headers(request.headers);
    if (attempt) headers.set(unsentAttemptHeader, attempt);
    // A safe read has no body, so it is rebuilt with the name; a model call's copy is below.
    let resend: Request = attempt && !model ? new Request(request, { headers }) : request;
    if (model) {
      await copy.ready;
      const held = copy.take();
      if ("refused" in held) break;
      resend = new Request(request.url, {
        method: request.method,
        headers,
        body: held.body,
        redirect: request.redirect,
        signal: request.signal,
      });
    }
    await (hop.wait ?? sleep)(controllerReplayDelayMs, request.signal);
    sends++;
    try {
      const next = await hop.controller().fetch(resend);
      void response.body?.cancel().catch(() => {});
      response = next;
    } catch (error) {
      if (request.signal.aborted) throw error;
      // The old instance reset itself while this send was on its way; the next one reaches the new.
      if (controllerInstanceEnded(error)) continue;
      // Any other failure: the caller still gets the retryable refusal it already holds.
      break;
    }
  }
  console.info("POOL_CODE_HANDOVER_WAITED", {
    cause,
    sends,
    waitedMs: now() - begun,
    outcome: resendable(response) ? "refused" : "answered",
  });
  return withoutUnsentMark(response);
}

async function forwardHeld(
  request: Request,
  hop: ControllerHop,
  model: boolean,
  requestId: string,
  copy: HeldBody,
): Promise<Response> {
  const now = hop.now ?? Date.now;
  const begun = now();
  let attempt = 0;
  const send = async (outgoing: Request) => {
    const started = now();
    attempt++;
    try {
      return await hop.controller().fetch(outgoing);
    } catch (error) {
      console.error(
        "POOL_CONTROLLER_CALL_FAILED",
        JSON.stringify({
          at: now(),
          requestId,
          endpoint: endpointOf(request),
          attempt,
          elapsedMs: now() - started,
          ...shape(error),
        }),
      );
      throw error;
    }
  };
  let response: Response;
  try {
    response = await send(request);
  } catch (error) {
    if (!controllerInstanceEnded(error) || request.signal.aborted) throw error;
    if (!model && !safeRead(request)) {
      const pathname = new URL(request.url).pathname;
      if (!isPublicModelPath(pathname)) {
        // A control write's callers may not assume it was not applied, so they keep its failure.
        report(hop, request, requestId, "surfaced", error, "not_replayable");
        throw error;
      }
      if (request.method === "POST" && !modelCallReplayable(pathname)) {
        // A job the provider may have accepted is never started twice, whatever its headers say
        // (model sockets are GET); its client decides.
        report(hop, request, requestId, "outcome_unknown", error, "not_replayable");
        return upstreamOutcomeUnknown(requestId, pathname);
      }
      // A model socket or a job status read starts nothing, and an allow-listed call it could not
      // hold costs one response at most, so its client retries it.
      report(hop, request, requestId, "retry_advised", error, "not_replayable");
      return retryAdvice(request, requestId);
    }
    await copy.ready;
    const held = copy.take();
    if ("refused" in held) {
      report(hop, request, requestId, "retry_advised", error, held.refused);
      return retryAdvice(request, requestId);
    }
    if (now() - begun > controllerReplayWindowMs) {
      report(hop, request, requestId, "retry_advised", error, "too_late");
      return retryAdvice(request, requestId);
    }
    try {
      await (hop.wait ?? sleep)(controllerReplayDelayMs, request.signal);
      response = await send(
        model
          ? new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: held.body,
              redirect: request.redirect,
              signal: request.signal,
            })
          : request,
      );
    } catch (replayError) {
      if (request.signal.aborted) {
        report(hop, request, requestId, "client_left", error);
        throw replayError;
      }
      report(hop, request, requestId, "replay_failed", replayError);
      if (!controllerInstanceEnded(replayError)) throw replayError;
      return retryAdvice(request, requestId);
    }
    report(hop, request, requestId, "replayed", error, undefined, response.ok);
  }
  response = await awaitHandover(request, hop, model, copy, response, begun);
  copy.release();
  const controllerRequestId = response.headers.get("X-Request-Id");
  // A resumable answer is re-attached through the new instance first; only an answer it cannot
  // resume reaches the retry terminal below, unchanged.
  const answer = resumableAnswer(response, {
    resume: (input) => {
      const controller = hop.controller();
      return controller.resume
        ? controller.resume(input)
        : Promise.reject(new Error("This controller cannot resume a stream"));
    },
    ended: controllerInstanceEnded,
    wait: hop.wait ?? sleep,
    now,
    delayMs: controllerReplayDelayMs,
    signal: request.signal,
  });
  return nativeRuntimeStream(answer, request, (error) =>
    report(
      hop,
      request,
      controllerRequestId && /^[0-9a-f-]{36}$/.test(controllerRequestId)
        ? controllerRequestId
        : crypto.randomUUID(),
      "stream_ended",
      error,
    ),
  );
}
