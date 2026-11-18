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

/** Clients reconnected 0.2-0.8 s after the 2026-11-18 reset, and retry advice already says 1 s. */
export const controllerReplayDelayMs = 1_000;
/** A model call's body is held, up to this size, only until the controller answers. */
export const controllerHoldBytes = 4 * 1024 * 1024;
/** A device call's signed assertion lives 25 s (token.ts); a later replay would be refused as stale. */
export const controllerReplayWindowMs = 20_000;

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
}

type Outcome =
  | "replayed"
  | "replay_failed"
  | "retry_advised"
  | "surfaced"
  | "outcome_unknown"
  | "client_left"
  | "stream_ended";
type Reason = "body_too_large" | "body_unreadable" | "not_replayable" | "too_late";

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

type Held = { body: Uint8Array<ArrayBuffer> } | { refused: "body_too_large" | "body_unreadable" };

/** Reads a tee of the body beside the real send, and gives up past the bound. */
function hold(body: ReadableStream<Uint8Array> | null) {
  if (!body) return { held: Promise.resolve<Held>({ body: new Uint8Array() }), release() {} };
  const reader = body.getReader();
  const release = () => void reader.cancel().catch(() => {});
  const held = (async (): Promise<Held> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > controllerHoldBytes) {
          release();
          return { refused: "body_too_large" };
        }
        chunks.push(value);
      }
    } catch {
      return { refused: "body_unreadable" };
    }
    // The chunks are dropped once joined, so the copy is brief and bounded by the hold.
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body: joined };
  })();
  return { held, release };
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
  const copy = hold(model && request.body ? request.clone().body : null);
  const now = hop.now ?? Date.now;
  const requestId = crypto.randomUUID();
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
    if (!controllerInstanceEnded(error) || request.signal.aborted) {
      copy.release();
      throw error;
    }
    if (!model && !safeRead(request)) {
      const pathname = new URL(request.url).pathname;
      if (!isPublicModelPath(pathname)) {
        // A control write's callers may not assume it was not applied, so they keep its failure.
        report(hop, request, requestId, "surfaced", error, "not_replayable");
        throw error;
      }
      if (request.method === "POST" && !request.headers.has("upgrade")) {
        // A job the provider may have accepted is never started twice; its client decides.
        report(hop, request, requestId, "outcome_unknown", error, "not_replayable");
        return upstreamOutcomeUnknown(requestId, pathname);
      }
      // A model socket or a job status read starts nothing, so its client retries it.
      report(hop, request, requestId, "retry_advised", error, "not_replayable");
      return retryAdvice(request, requestId);
    }
    const held = await copy.held;
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
  // The answer has started, so the held copy can never be sent again.
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
