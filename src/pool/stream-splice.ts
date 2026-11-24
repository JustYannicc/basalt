import { boundedLog } from "./bounded-log.ts";
/**
 * Resumable model streams, contract v1 (issue #1642): the container's front layer keeps a call's
 * raw answer for a while, and when the hop that streams it loses the hop below mid-body it
 * re-attaches from the bytes it delivered and splices the rest in. This part imports nothing of the
 * pool's runtime, so the router can splice too; the pool decodes a target strictly when it serves a
 * resume.
 */
export const streamResumableHeader = "X-Basalt-Resumable";
export const streamResumeHeader = "X-Basalt-Resume";
export const streamResumeVersion = "v1";
export const streamResumeTargetHeader = "X-Basalt-Resume-Target";
export const streamResumeFromHeader = "X-Basalt-Resume-From";
export const streamResumeBootHeader = "X-Basalt-Resume-Boot";
export const streamResumeStateHeader = "X-Basalt-Resume-State";
export const streamBootHeader = "X-Signalbox-Pool-Boot";
/** The pool a call was admitted under, so a resume is admitted under that pool only. */
export const streamResumePoolHeader = "X-Basalt-Resume-Pool";
/** The layer's answer when it could not reach the node: no request byte reached the node. */
export const streamResumeUpstreamHeader = "X-Basalt-Resume-Upstream";
export const streamResumePath = "/__basalt/resume/v1/";
/**
 * Set by the controller on a finite model call it would let the front layer keep. The hop that
 * owns the container turns it into the layer's mark only while the container advertises the layer.
 */
export const streamResumeEligibleHeader = "X-Basalt-Resume-Eligible";
/** The front layer's own port; marked calls and resume reads only. */
export const resumeLayerPort = 8316;
/** Attempts per cut; each waits the replay delay first, as the reset replay does. */
export const streamResumeAttempts = 3;
/** A cut's attempts end this long after it; a new instance answers within seconds. */
export const streamResumeWindowMs = 20_000;
/** Cuts one answer is resumed from, each only after the delivered offset moved. */
export const streamResumeCuts = 5;
export const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const internalHeaders = [
  streamResumeHeader,
  streamResumeTargetHeader,
  streamResumeStateHeader,
  streamResumePoolHeader,
];
/**
 * The events that end a messages or responses stream, for the entry's retry terminal and the
 * router's cut judge alike. `response.done` is what some providers' executors pass through
 * unchanged; the pool's own framer counts it as the end.
 */
export const streamTerminalTypes: ReadonlySet<string> = new Set([
  "message_stop",
  "response.completed",
  "response.done",
  "response.failed",
  "response.incomplete",
  "error",
]);
/** The opaque value a resume hands back; only its shape is checked before the pool decodes it. */
export const resumeTargetShape = /^(?:primary|runtime:[A-Za-z0-9_-]{1,4096})$/;

/**
 * The call a resume continues, as its caller made it: method, path and headers, credentials
 * included, as plain values so it crosses RPC. The pool admits it as it admits a new call.
 */
export interface ResumeCall {
  method: string;
  path: string;
  headers: [string, string][];
  /** The pool the call was admitted under, when it had one. */
  pool?: string;
}

export interface StreamResumeInput {
  requestId: string;
  from: number;
  target: string;
  boot: string;
  call?: ResumeCall;
}

// Framing of the original upload, not part of who made the call.
const framing = new Set([
  "content-length",
  "content-type",
  "content-encoding",
  "transfer-encoding",
]);

/** The call a resume continues, from the request its caller sent. */
export function resumeCall(request: Request, headers: Headers = request.headers): ResumeCall {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname + url.search,
    headers: [...headers].filter(([name]) => !framing.has(name)),
  };
}

export interface SpliceDeps {
  /** Resolved per attempt, as a fresh stub. */
  resume(input: StreamResumeInput): Promise<Response>;
  /** The platform's "this instance is no longer active" error, the only cut a resume can heal. */
  ended(error: unknown): boolean;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  now(): number;
  delayMs: number;
  signal: AbortSignal;
  /**
   * Sees every byte delivered, across resumed parts, and says at the end whether the answer is
   * whole. Where a lost hop below ends the body instead of failing it, an end it calls incomplete is
   * a cut like any other. Without it, only a failed read is a cut.
   */
  complete?: { push(bytes: Uint8Array): void; whole(): boolean };
}

/**
 * The entry side of a resumable answer. It counts the raw bytes it delivered, and when the
 * controller instance ends mid-body it re-attaches from that offset and splices the rest in. When
 * no resume works it ends with the original error, so the caller's stream ends exactly as today.
 * An answer the front layer did not mark is returned untouched.
 */
export function resumableAnswer(response: Response, deps: SpliceDeps): Response {
  if (!internalHeaders.some((name) => response.headers.has(name))) return response;
  const requestId = response.headers.get("X-Request-Id") ?? "";
  const target = response.headers.get(streamResumeTargetHeader) ?? "";
  const boot = response.headers.get(streamBootHeader) ?? "";
  const headers = new Headers(response.headers);
  for (const name of internalHeaders) headers.delete(name);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (
    !response.ok ||
    !response.body ||
    response.headers.get(streamResumeHeader) !== streamResumeVersion ||
    !requestIdPattern.test(requestId) ||
    !resumeTargetShape.test(target) ||
    !boot
  )
    // Not resumable after all: the same answer, with nothing internal left in it.
    return new Response(response.body, init);
  let reader = response.body.getReader();
  let delivered = 0;
  let cuts = 0;
  let resumedAt = -1;
  let cancelled = false;
  const reattach = async () => {
    const cutAt = deps.now();
    for (let attempt = 1; attempt <= streamResumeAttempts; attempt++) {
      // A reader that left wants nothing more; each try would only take the layer's reader.
      if (cancelled || deps.signal.aborted) break;
      if (deps.now() - cutAt + deps.delayMs > streamResumeWindowMs) break;
      await deps.wait(deps.delayMs, deps.signal);
      let answer: Response | undefined;
      try {
        answer = await withinWindow(
          deps.resume({ requestId, from: delivered, target, boot }),
          streamResumeWindowMs - (deps.now() - cutAt),
        );
      } catch (error) {
        // The new instance may not be up yet; any other refusal means it cannot resume.
        if (deps.ended(error) && !deps.signal.aborted) continue;
        return { outcome: "failed" as const, attempt };
      }
      if (!answer) return { outcome: "failed" as const, attempt };
      if (
        answer.status === 200 &&
        answer.body &&
        answer.headers.get(streamResumeHeader) === streamResumeVersion &&
        answer.headers.get(streamResumeFromHeader) === String(delivered)
      )
        return { outcome: "resumed" as const, attempt, reader: answer.body.getReader() };
      void answer.body?.cancel().catch(() => {});
      return { outcome: answer.status === 410 ? ("gone" as const) : ("failed" as const), attempt };
    }
    return { outcome: "failed" as const, attempt: streamResumeAttempts };
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try {
            part = await reader.read();
            if (part.done && deps.complete && !deps.complete.whole())
              throw new Error("The answer ended before its terminal event");
          } catch (error) {
            if (!deps.ended(error) || deps.signal.aborted || cancelled) throw error;
            // A cut with no byte delivered since the last resume, or one too many, is not resumed.
            if (++cuts > streamResumeCuts || delivered === resumedAt) throw error;
            const result = await reattach();
            boundedLog("POOL_STREAM_RESUME", {
              requestId,
              outcome: result.outcome,
              attempts: result.attempt,
              from: delivered,
            });
            // No resume: the original error ends the stream, so today's retry terminal follows.
            if (result.outcome !== "resumed") throw error;
            // The client left while the resume was asked for: the resumed part is not kept open.
            if (cancelled || deps.signal.aborted) {
              void result.reader.cancel().catch(() => {});
              throw error;
            }
            reader = result.reader;
            resumedAt = delivered;
            continue;
          }
          if (part.done) return controller.close();
          deps.complete?.push(part.value);
          delivered += part.value.byteLength;
          return controller.enqueue(part.value);
        }
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason);
      },
    }),
    init,
  );
}

/** The answer if it comes within the window, or nothing; a later one is cancelled when it comes. */
async function withinWindow(answer: Promise<Response>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, milliseconds), undefined);
  });
  try {
    const first = await Promise.race([answer, late]);
    if (!first) void answer.then((value) => value.body?.cancel()).catch(() => {});
    return first;
  } finally {
    clearTimeout(timer);
  }
}
