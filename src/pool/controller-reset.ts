import { captureError } from "../telemetry/sentry.ts";
import { pageTemplate } from "../telemetry/privacy.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { awaitProbe } from "./availability.ts";
import { unavailableResponse } from "./json.ts";
import { isPublicModelPath } from "./lifecycle.ts";
import { endpointMetadata } from "./model-history/record.ts";
import { nativeRuntimeStream, nativeRuntimeUnavailable } from "./runtime-unavailable.ts";

/** Clients reconnected 0.2-0.8 s after the 2026-11-18 reset, and retry advice already says 1 s. */
export const controllerReplayDelayMs = 1_000;

// The platform may end the controller instance at any time; this is its "reconnect or retry" error.
const instanceEnded = /\bDurable Object instance is no longer active\b/i;

export function controllerInstanceEnded(error: unknown): boolean {
  return (
    error instanceof Error &&
    !("overloaded" in error && error.overloaded === true) &&
    instanceEnded.test(error.message)
  );
}

export interface ControllerHop {
  /** Resolved per attempt, so a replay reaches the replacement instance. */
  controller(): { fetch(request: Request): Promise<Response> };
  env: SentryEnv;
  defer(work: Promise<unknown>): void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

type Outcome = "replayed" | "replay_failed" | "retry_advised" | "surfaced" | "stream_ended";

/** These reads write no request record, choose no account and reserve no usage in the controller. */
function replayable(request: Request): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    !request.headers.has("upgrade") &&
    endpointMetadata(new URL(request.url).pathname).apiType !== "video-retrieve"
  );
}

function report(
  hop: ControllerHop,
  request: Request,
  requestId: string,
  outcome: Outcome,
  error: unknown,
) {
  const pathname = new URL(request.url).pathname;
  console.error(
    "POOL_CONTROLLER_INTERRUPTED",
    JSON.stringify({
      count: 1,
      requestId,
      outcome,
      cause: controllerInstanceEnded(error) ? "instance_ended" : "transport",
      method: ["GET", "HEAD", "POST"].includes(request.method) ? request.method : "other",
      endpoint: endpointMetadata(pathname).endpoint ?? pageTemplate(pathname),
      signalAborted: request.signal.aborted,
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
 * The controller may have dispatched any request it received, so only a safe read is sent twice.
 * A model call gets the native retry advice its client already follows, and a stream that
 * started is never replayed: it ends with the native retry terminal instead.
 */
export async function fetchController(request: Request, hop: ControllerHop): Promise<Response> {
  let response: Response;
  try {
    response = await hop.controller().fetch(request);
  } catch (error) {
    if (!controllerInstanceEnded(error) || request.signal.aborted) throw error;
    const requestId = crypto.randomUUID();
    if (!replayable(request)) {
      // A control write's callers keep today's unknown-outcome failure; only model clients retry.
      const model = isPublicModelPath(new URL(request.url).pathname);
      report(hop, request, requestId, model ? "retry_advised" : "surfaced", error);
      if (!model) throw error;
      return retryAdvice(request, requestId);
    }
    try {
      await (hop.wait ?? sleep)(controllerReplayDelayMs, request.signal);
      response = await hop.controller().fetch(request);
    } catch (replayError) {
      report(hop, request, requestId, "replay_failed", replayError);
      if (request.signal.aborted || !controllerInstanceEnded(replayError)) throw replayError;
      return retryAdvice(request, requestId);
    }
    report(hop, request, requestId, "replayed", error);
  }
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
