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
import { sentNowhere, withoutUnsentMark } from "./controller-unsent.ts";

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
// Each reservation carries its own deadline: a request the platform cancels never runs its own
// release, and its bytes must not stay counted for the life of the isolate.
const reservations = new Map<object, { bytes: number; until: number }>();
/** Bytes held for replay in this isolate right now. */
export function controllerHeldBytes(now = Date.now()) {
  let total = 0;
  for (const [key, reservation] of reservations) {
    if (reservation.until <= now) reservations.delete(key);
    else total += reservation.bytes;
  }
  return total;
}

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
  controller(): { fetch(request: Request): Promise<Response> };
  env: SentryEnv;
  defer(work: Promise<unknown>): void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  holdBudgetBytes?: number;
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

type Refusal = "body_too_large" | "body_unreadable" | "hold_budget_full" | "too_late";
type Held = { body: Uint8Array<ArrayBuffer> } | { refused: Refusal };

/**
 * Reads a tee of the body beside the real send and holds it only while a replay is still
 * possible: up to the per-call and per-isolate bounds, and until the controller answers or the
 * replay window closes, whichever is first.
 */
function hold(body: ReadableStream<Uint8Array> | null, budget: number, skipped: () => void) {
  if (!body)
    return {
      ready: Promise.resolve(),
      take: (): Held => ({ body: new Uint8Array() }),
      release() {},
    };
  const reader = body.getReader();
  const key = {};
  const until = Date.now() + controllerReplayWindowMs;
  let chunks: Uint8Array[] | undefined = [];
  let joined: Uint8Array<ArrayBuffer> | undefined;
  let refused: Refusal | undefined;
  let reserved = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const free = (reason: Refusal | "released") => {
    if (!refused && reason !== "released") refused = reason;
    if (reason === "released" && !refused) refused = "too_late";
    chunks = undefined;
    joined = undefined;
    reservations.delete(key);
    reserved = 0;
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  };
  timer = setTimeout(() => free("too_late"), controllerReplayWindowMs);
  const ready = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !chunks) break;
        if (reserved + value.byteLength > controllerHoldBytes) return free("body_too_large");
        if (controllerHeldBytes() + value.byteLength > budget) {
          skipped();
          return free("hold_budget_full");
        }
        reserved += value.byteLength;
        reservations.set(key, { bytes: reserved, until });
        chunks.push(value);
      }
    } catch {
      return free("body_unreadable");
    }
    if (!chunks) return;
    const whole = new Uint8Array(reserved);
    let offset = 0;
    for (const chunk of chunks) {
      whole.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks = undefined;
    joined = whole;
  })();
  return {
    ready,
    take: (): Held => (joined ? { body: joined } : { refused: refused ?? "body_unreadable" }),
    release: () => free("released"),
  };
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
  const model = replayableCall(request);
  const requestId = crypto.randomUUID();
  const copy = hold(
    model && request.body ? request.clone().body : null,
    hop.holdBudgetBytes ?? controllerHoldBudgetBytes,
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
  try {
    return await forwardHeld(request, hop, model, requestId, copy);
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
  copy: ReturnType<typeof hold>,
  response: Response,
  begun: number,
): Promise<Response> {
  if (!resendable(response) || (!model && !safeRead(request))) return withoutUnsentMark(response);
  const now = hop.now ?? Date.now;
  const cause = handingOver(response) ? "handover" : "unsent";
  let sends = 0;
  while (resendable(response)) {
    if (now() - begun + controllerReplayDelayMs > controllerReplayWindowMs) break;
    let resend: Request = request;
    if (model) {
      await copy.ready;
      const held = copy.take();
      if ("refused" in held) break;
      resend = new Request(request.url, {
        method: request.method,
        headers: request.headers,
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
  copy: ReturnType<typeof hold>,
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
  return nativeRuntimeStream(response, request, (error) =>
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
