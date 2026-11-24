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
  streamTerminalTypes,
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
  // The pool's own framers always end these streams with a terminal event, so their end is judged.
  // A lone carriage return as a line ending is out of contract here, as in the entry's own reader.
  const judged =
    /^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "") &&
    /\/(?:messages|responses|chat\/completions)$/.test(new URL(request.url).pathname);
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
  // One event is held up to this; past it only its head, which names its type, is kept.
  const limit = 256 * 1024;
  const headLength = 4 * 1024;
  // The open event is kept as its pieces, joined once when it closes, so a read costs its own length.
  let parts: string[] = [];
  let held = 0;
  // Past the bound only the event's head is kept.
  let head: string | undefined;
  // The last three characters read: a boundary can begin in them and end in the next read.
  let tail = "";
  // Once the terminal event is seen the answer is whole; a ping or comment after it changes nothing.
  let terminal = false;
  // An event too large to hold whole, whose head names no type, arrived complete; when it is the
  // last one the answer is taken as whole, never judged stricter than the entry, which parses it.
  let unknownLast = false;
  const close = (event: string, truncated = false) => {
    const data = eventData(event);
    if (data === undefined) return;
    // The event's own name says the same in both protocols, and survives a head cut short.
    const name = eventName(event);
    if (isTerminal(data) || terminalTypes.has(name)) terminal = true;
    unknownLast = truncated && !name && leadingType(data) === undefined;
  };
  const scan = (incoming: string) => {
    let text = incoming;
    while (text) {
      const joined = tail + text;
      const end = /\r?\n\r?\n/.exec(joined);
      if (!end) {
        if (head === undefined) {
          parts.push(text);
          held += text.length;
          if (held > limit) {
            head = parts.join("").slice(0, headLength);
            parts = [];
          }
        }
        tail = joined.slice(-3);
        return;
      }
      // Where the event ends in the held text and this read; it may begin inside the tail.
      const eventEnd = held + end.index - tail.length;
      if (head !== undefined) close(head, true);
      else close((parts.join("") + text).slice(0, eventEnd));
      parts = [];
      held = 0;
      head = undefined;
      tail = "";
      text = joined.slice(end.index + end[0].length);
    }
  };
  return {
    push: (bytes: Uint8Array) => scan(decoder.decode(bytes, { stream: true })),
    // Only a closed terminal event counts: one still open at the end was cut before its blank line,
    // and a client's event parser drops it.
    whole() {
      scan(decoder.decode());
      return terminal || unknownLast;
    },
  };
}

function eventName(event: string) {
  const line = event.split(/\r?\n/).find((value) => value.startsWith("event:"));
  return line === undefined ? "" : line.slice(6).trim();
}

function eventData(event: string) {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return lines.length ? lines.join("\n") : undefined;
}

const terminalTypes = streamTerminalTypes;

/** The last event of a messages, responses or chat completions stream. */
function isTerminal(data: string) {
  if (data === "[DONE]") return true;
  // A chat completions stream that fails ends with a bare error object instead of [DONE].
  if (/^\s*\{\s*"error"\s*:/.test(data)) return true;
  try {
    const value: unknown = JSON.parse(data);
    return (
      typeof value === "object" &&
      value !== null &&
      terminalTypes.has(String((value as { type?: unknown }).type))
    );
  } catch {
    // Only the head of a very large event is kept; its type comes first when it can be read.
    const type = leadingType(data);
    return type !== undefined && terminalTypes.has(type);
  }
}

function leadingType(data: string) {
  return /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(data)?.[1];
}
