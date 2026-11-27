// The mock's own record of when it sent each load send's answer: the load proof's second witness,
// beside the driver's own timing. A send is recorded only when its prompt carries a load marker.
import { frameTimer, type Shape } from "./frames.ts";
import { markerPattern } from "./prompts.ts";

/** One answer the mock passed on, in epoch milliseconds on the Worker's clock. */
export interface MockSend {
  readonly marker: string;
  readonly path: string;
  readonly status: number;
  readonly receivedAt: number;
  readonly headersAt: number;
  /** The first frame that adds text to the judged answer; a JSON answer's end. */
  readonly firstContentAt?: number;
  /** The longest wait between two such frames, and from the last of them to the end. */
  readonly stallMs?: number;
  readonly endedAt: number;
  /** cut: the reader cancelled, or the mock's own body broke off. */
  readonly end: "complete" | "cut";
}

/** Every route the mock answers is keyed (gateway.ts); this one reads a run's records back. */
export const sendsPath = "/_emulated/sends";
export const sendsPage = 1_000;
const runPattern = /^[0-9a-f]{16}$/u;
const cursorPattern = /^\d{15}-\d{9}$/u;

/** The marker a body carries, and the run it names. */
export function markerIn(body: string) {
  const match = markerPattern.exec(body);
  return match ? { marker: match[0], run: match[1]! } : undefined;
}

export interface SendStore {
  save(run: string, send: MockSend): Promise<void>;
  /** A page of one run's records in the order they were saved, and the cursor after it. */
  list(run: string, after?: string): Promise<{ sends: MockSend[]; next?: string }>;
}

/** The subset of a Durable Object's storage the record uses. */
export interface SendStorage {
  put(key: string, value: MockSend, options?: { allowUnconfirmed?: boolean }): Promise<void>;
  list(options: {
    prefix: string;
    startAfter?: string;
    limit: number;
  }): Promise<Map<string, unknown>>;
}

/**
 * Records under `send:<run>:<time>-<counter>`, in saved order. A put is not confirmed before the
 * object's next output, so no write holds back another call's frames; a write that is lost shows
 * as a missing record, which fails the proof.
 */
export function durableSends(storage: SendStorage, now = () => Date.now()): SendStore {
  let counter = 0;
  return {
    save: (run, send) =>
      storage.put(
        `send:${run}:${String(now()).padStart(15, "0")}-${String(counter++ % 1e9).padStart(9, "0")}`,
        send,
        { allowUnconfirmed: true },
      ),
    async list(run, after) {
      const prefix = `send:${run}:`;
      const page = await storage.list({
        prefix,
        startAfter: after === undefined ? undefined : prefix + after,
        limit: sendsPage,
      });
      const keys = [...page.keys()];
      return {
        sends: [...page.values()] as MockSend[],
        next: keys.length === sendsPage ? keys.at(-1)!.slice(prefix.length) : undefined,
      };
    },
  };
}

const shapeOf: Readonly<Record<string, Shape>> = {
  "/v1/chat/completions": "chat",
  "/v1/responses": "responses",
  "/v1/messages": "messages",
};

/**
 * The answer as the mock passes it on, recorded once its body ends or is cancelled. The body is
 * pulled with no buffer, so a frame is timed when the caller takes it: a caller that stops reading
 * makes the record later, never earlier.
 */
export function recorded(
  answer: Response,
  {
    marker,
    path,
    receivedAt,
    now,
    save,
  }: {
    marker: string;
    path: string;
    receivedAt: number;
    now: () => number;
    save: (send: MockSend) => void;
  },
): Response {
  const headersAt = now();
  const shape = shapeOf[path];
  const streamed = (answer.headers.get("content-type") ?? "").includes("text/event-stream");
  const timer = shape && streamed ? frameTimer(shape) : undefined;
  const decoder = new TextDecoder();
  let saved = false;
  const finish = (end: MockSend["end"]) => {
    if (saved) return;
    saved = true;
    const endedAt = now();
    timer?.end(endedAt);
    save({
      marker,
      path,
      status: answer.status,
      receivedAt,
      headersAt,
      firstContentAt: timer ? timer.firstContentMs : end === "complete" ? endedAt : undefined,
      stallMs: timer?.stallMs,
      endedAt,
      end,
    });
  };
  const reader = answer.body?.getReader();
  if (!reader) {
    finish("complete");
    return answer;
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await reader.read();
        } catch (error) {
          finish("cut");
          controller.error(error);
          return;
        }
        if (part.done) {
          timer?.observe(decoder.decode(), now());
          finish("complete");
          controller.close();
          return;
        }
        timer?.observe(decoder.decode(part.value, { stream: true }), now());
        controller.enqueue(part.value);
      },
      cancel(reason) {
        finish("cut");
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: answer.headers,
  });
}

/** GET one run's records, a page at a time; the run and cursor are checked before any read. */
export async function sendsControl(request: Request, store: SendStore): Promise<Response> {
  if (request.method !== "GET")
    return Response.json(
      { error: { type: "method_not_allowed" } },
      { status: 405, headers: { allow: "GET" } },
    );
  const query = new URL(request.url).searchParams;
  const run = query.get("run") ?? "";
  const after = query.get("after") ?? undefined;
  if (!runPattern.test(run) || (after !== undefined && !cursorPattern.test(after)))
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "Expected run: 16 hex digits, and after: a cursor this route gave",
        },
      },
      { status: 400 },
    );
  return Response.json(await store.list(run, after));
}
