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
  // Only these streams always end with a terminal event, so only their end is judged.
  const judged =
    /^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "") &&
    /\/(?:messages|responses)$/.test(new URL(request.url).pathname);
  const spliced = resumableAnswer(new Response(response.body, init), {
    ...(judged ? { complete: terminalJudge() } : {}),
    resume: async (input) => {
      const answer = await env.POOL_SERVICE.fetch(
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
      );
      // The controller is not back yet: a try that failed, so the splice tries again.
      if (answer.status === 503) {
        void answer.body?.cancel().catch(() => {});
        throw new Error("The pool's resume is not ready");
      }
      return answer;
    },
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
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          // A pending BYOB read is answered with nothing once the stream has closed.
          controller.byobRequest?.respond(0);
          return;
        }
        // A byte stream refuses an empty chunk; there is nothing to hand on in one.
        if (next.value.byteLength) return controller.enqueue(new Uint8Array(next.value));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * When the pool Worker's isolate goes down mid-answer, the router's binding body does not fail: it
 * ends, cleanly, where the answer stopped (real workerd, model-resume.workerd.test.ts). A messages
 * or responses stream that ends before its terminal event is that cut. This sees every delivered
 * byte across resumed parts, which start mid-event, so one decoder and one pending event span them.
 */
function terminalJudge() {
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
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
    for (const event of events) {
      // A comment, a keep-alive or a blank separator carries no data and changes nothing.
      const data = eventData(event);
      if (data !== undefined) terminal = isTerminal(data);
    }
    if (pending.length > limit) {
      judged = false;
      pending = "";
    }
  };
  return {
    push: (bytes: Uint8Array) => scan(decoder.decode(bytes, { stream: true })),
    whole() {
      scan(decoder.decode());
      const data = eventData(pending);
      return !judged || (data !== undefined ? isTerminal(data) : terminal);
    },
  };
}

function eventData(event: string) {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return lines.length ? lines.join("\n") : undefined;
}

const terminalTypes = new Set([
  "message_stop",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

/** The last event of a messages or responses stream. */
function isTerminal(data: string) {
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
