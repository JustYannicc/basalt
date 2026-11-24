import { routerAttemptHeader, signRouterAttempt } from "./pool/router-attempt.ts";
import {
  openResumeStamp,
  routerResumeHeader,
  routerResumePath,
} from "./pool/router-resume-contract.ts";
import {
  resumableAnswer,
  streamBootHeader,
  streamResumeHeader,
  streamResumeTargetHeader,
  streamResumeVersion,
} from "./pool/stream-splice.ts";

/** As the entry waits before each re-attach (controller-reset.ts). */
export const routerResumeDelayMs = 1_000;

interface Resumer {
  POOL_SERVICE: { fetch(request: Request): Promise<Response> };
  POOL_APP_SIGNING_KEY: string;
}

/**
 * A streamed answer the entry stamped resumable. When its body breaks, which from here is the pool
 * Worker's isolate going down under the entry, the router re-attaches through the pool's resume
 * route from the bytes it delivered and splices the rest in, within the entry's own bounds (three
 * attempts inside 20 s for one cut, five cuts per answer; `stream-resume.ts`). Without a stamp, or
 * when no resume works, the answer ends exactly as it would have; the stamp never reaches a client.
 */
export async function resumeThroughRouter(
  response: Response,
  request: Request,
  env: Resumer,
  requestId: string,
  nextAttempt: () => number,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<Response> {
  const value = response.headers.get(routerResumeHeader);
  if (value === null) return response;
  const headers = new Headers(response.headers);
  headers.delete(routerResumeHeader);
  const stamp = await openResumeStamp(value, env.POOL_APP_SIGNING_KEY);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (!stamp || stamp.requestId !== requestId) return new Response(response.body, init);
  // The entry's own splice reads these; here they come from the stamp and are stripped by it.
  headers.set(streamResumeHeader, streamResumeVersion);
  headers.set(streamResumeTargetHeader, stamp.target);
  headers.set(streamBootHeader, stamp.boot);
  headers.set("X-Request-Id", requestId);
  const body =
    response.body && /^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "")
      ? endsWithTerminal(response.body)
      : response.body;
  const spliced = resumableAnswer(new Response(body, init), {
    resume: async (input) =>
      env.POOL_SERVICE.fetch(
        new Request(new URL(routerResumePath, request.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [routerAttemptHeader]: await signRouterAttempt(env.POOL_APP_SIGNING_KEY, {
              requestId,
              attempt: nextAttempt(),
            }),
          },
          body: JSON.stringify({ stamp: value, from: input.from }),
          signal: request.signal,
        }),
      ),
    // From the router every broken body is the pool going down; a cut the layer cannot serve
    // answers gone, and the original error ends the stream as it would have.
    ended: () => true,
    wait,
    now: Date.now,
    delayMs: routerResumeDelayMs,
    signal: request.signal,
  });
  if (!spliced.body) return spliced;
  return new Response(byteStream(spliced.body), {
    status: spliced.status,
    statusText: spliced.statusText,
    headers: spliced.headers,
  });
}

/** The device tunnel reads with a BYOB reader, which only a byte stream serves. */
function byteStream(source: ReadableStream<Uint8Array>) {
  const reader = source.getReader();
  return new ReadableStream({
    type: "bytes",
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        // A pending BYOB read is answered with nothing once the stream has closed.
        controller.byobRequest?.respond(0);
        return;
      }
      controller.enqueue(new Uint8Array(next.value));
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * When the pool Worker's isolate goes down mid-answer, the router's binding body does not fail: it
 * ends, cleanly, where the answer stopped (real workerd, model-resume.workerd.test.ts). An event
 * stream that ends before its terminal event is that cut, so it reads as one here, and the splice
 * resumes it. Bytes pass through unchanged; only how the stream ends is judged.
 */
function endsWithTerminal(source: ReadableStream<Uint8Array>) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  // Only the event being read is kept, and only up to a bound; past it the end is not judged.
  const limit = 256 * 1024;
  let pending = "";
  let judged = true;
  let terminal = false;
  const scan = (text: string) => {
    if (!judged) return;
    pending += text;
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop() ?? "";
    for (const event of events) terminal = isTerminal(event);
    if (pending.length > limit) {
      judged = false;
      pending = "";
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        scan(decoder.decode());
        if (pending.trim()) terminal = isTerminal(pending);
        if (judged && !terminal)
          return controller.error(new Error("The pool's answer ended before its terminal event"));
        return controller.close();
      }
      scan(decoder.decode(next.value, { stream: true }));
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const terminalTypes = new Set([
  "message_stop",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

/** The last event of a messages, responses or chat completions stream. */
function isTerminal(event: string) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (data === "[DONE]") return true;
  try {
    const value: unknown = JSON.parse(data);
    return (
      typeof value === "object" &&
      value !== null &&
      terminalTypes.has(String((value as { type?: unknown }).type))
    );
  } catch {
    return false;
  }
}
