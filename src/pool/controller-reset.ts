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
}

type Outcome = "replayed" | "replay_failed" | "retry_advised" | "surfaced" | "stream_ended";
type Reason = "body_too_large" | "not_replayable";

/** These reads write no request record, choose no account and reserve no usage in the controller. */
function safeRead(request: Request): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    !request.headers.has("upgrade") &&
    endpointMetadata(new URL(request.url).pathname).apiType !== "video-retrieve"
  );
}

/** A model call costs only tokens when sent twice; the pool records each attempt separately. */
function modelCall(request: Request): boolean {
  return (
    request.method === "POST" &&
    !request.headers.has("upgrade") &&
    isPublicModelPath(new URL(request.url).pathname)
  );
}

/** Reads a tee of the body beside the real send, and gives up past the bound. */
function hold(body: ReadableStream<Uint8Array> | null) {
  if (!body) return { bytes: Promise.resolve(new Uint8Array()), release() {} };
  const reader = body.getReader();
  const release = () => void reader.cancel().catch(() => {});
  const bytes = (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > controllerHoldBytes) {
          release();
          return undefined;
        }
        chunks.push(value);
      }
    } catch {
      return undefined;
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  })();
  return { bytes, release };
}

function report(
  hop: ControllerHop,
  request: Request,
  requestId: string,
  outcome: Outcome,
  error: unknown,
  reason?: Reason,
) {
  const pathname = new URL(request.url).pathname;
  console.error(
    "POOL_CONTROLLER_INTERRUPTED",
    JSON.stringify({
      count: 1,
      requestId,
      outcome,
      saved: outcome === "replayed",
      ...(reason ? { reason } : {}),
      cause: resetCause(error) ?? "transport",
      method: ["GET", "HEAD", "POST"].includes(request.method) ? request.method : "other",
      endpoint: endpointMetadata(pathname).endpoint ?? pageTemplate(pathname),
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
 * Surviving a controller replacement. Before the first response byte, a safe read or a model call
 * is sent once more to a new instance; a model call whose body was too large to hold, or that
 * fails again, gets the native retry advice its client follows. A started stream is never replayed:
 * it ends with the native retry terminal. A control write keeps today's unknown-outcome failure.
 */
export async function fetchController(request: Request, hop: ControllerHop): Promise<Response> {
  const model = modelCall(request);
  const held = hold(model && request.body ? request.clone().body : null);
  let attempt = 0;
  const send = async (outgoing: Request) => {
    const started = Date.now();
    attempt++;
    try {
      return await hop.controller().fetch(outgoing);
    } catch (error) {
      console.error(
        "POOL_CONTROLLER_CALL_FAILED",
        JSON.stringify({
          at: Date.now(),
          attempt,
          elapsedMs: Date.now() - started,
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
      held.release();
      throw error;
    }
    const requestId = crypto.randomUUID();
    if (!model && !safeRead(request)) {
      // A model socket has no body to hold; a control write's callers keep today's failure.
      const modelRoute = isPublicModelPath(new URL(request.url).pathname);
      report(
        hop,
        request,
        requestId,
        modelRoute ? "retry_advised" : "surfaced",
        error,
        "not_replayable",
      );
      if (!modelRoute) throw error;
      return retryAdvice(request, requestId);
    }
    const body = await held.bytes;
    if (!body) {
      report(hop, request, requestId, "retry_advised", error, "body_too_large");
      return retryAdvice(request, requestId);
    }
    try {
      await (hop.wait ?? sleep)(controllerReplayDelayMs, request.signal);
      response = await send(
        model
          ? new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body,
              signal: request.signal,
            })
          : request,
      );
    } catch (replayError) {
      report(hop, request, requestId, "replay_failed", replayError);
      if (request.signal.aborted || !controllerInstanceEnded(replayError)) throw replayError;
      return retryAdvice(request, requestId);
    }
    report(hop, request, requestId, "replayed", error);
  }
  // The answer has started, so the held copy can never be sent again.
  held.release();
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
