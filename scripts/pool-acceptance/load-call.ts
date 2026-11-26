import { randomBytes } from "node:crypto";
import { readRefusal, type ModelCredential, type PoolAcceptanceClient } from "./client.ts";
import { callBody, callVerdict, paths, type Shape, type Verdict } from "./load-verdict.mjs";
import type { LoadKind } from "./load-shape.ts";
import { isObject, type Refusal } from "./types.ts";

export interface Clock {
  /** Monotonic milliseconds, for durations. */
  now(): number;
  /** Epoch milliseconds, for the kill time and the run's log. */
  wall(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface CallContext {
  readonly client: PoolAcceptanceClient;
  readonly credential: ModelCredential;
  readonly clock: Clock;
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
}

/** complete: a 200 read to its end. cut: a 200 whose body broke off. status: any other status. */
export type AttemptEnd = "complete" | "status" | "cut" | "timeout" | "transport" | "too_large";

/** One send of a call, as its caller saw it. Ids and codes only: never a body's text. */
export interface Attempt {
  readonly attempt: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly end: AttemptEnd;
  readonly status?: number;
  /** The pool's id for this send (`X-Request-Id`), which its wide event logs as `requestId`. */
  readonly requestId?: string;
  readonly boot?: string;
  readonly retryAfterMs?: number;
  readonly refusal?: Refusal;
  readonly headersMs?: number;
  readonly firstByteMs?: number;
  readonly firstContentMs?: number;
  readonly totalMs: number;
  readonly verdict?: Verdict;
  /** The answer says a send again may work: a transport failure, a retryable status or Retry-After. */
  readonly retryable: boolean;
}

export interface CallRecord {
  readonly call: number;
  readonly worker: number;
  readonly kind: string;
  /** The W3C trace id every send of this call carries; the pool's wide event logs it as `traceId`. */
  readonly traceId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly attempts: readonly Attempt[];
}

const bodyLimit = 4 * 1024 * 1024;
const retryAfterCapMs = 60_000;
const requestIdPattern = /^[A-Za-z0-9-]{8,64}$/u;
const bootPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

const header = (response: Response, name: string, pattern: RegExp) => {
  const value = response.headers.get(name)?.trim();
  return value && pattern.test(value) ? value : undefined;
};

function retryAfter(value: string | null, wall: number) {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d{1,6}$/u.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - wall) : undefined;
}

// What the protocols' own SDKs send again: a timeout, a conflict, a rate limit or a server error.
const retryStatus = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500;

function frameHasContent(shape: Shape, data: string) {
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return false;
  }
  if (!isObject(frame)) return false;
  const text = (value: unknown) => typeof value === "string" && value !== "";
  if (shape === "responses")
    return frame.type === "response.output_text.delta" && text(frame.delta);
  if (shape === "messages")
    return (
      frame.type === "content_block_delta" &&
      isObject(frame.delta) &&
      frame.delta.type === "text_delta" &&
      text(frame.delta.text)
    );
  const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
  return isObject(choice) && isObject(choice.delta) && text(choice.delta.content);
}

/** Whether a stream's text so far holds its first content; it reads whole lines only. */
function contentProbe(shape: Shape) {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    return lines.some((line) => line.startsWith("data: ") && frameHasContent(shape, line.slice(6)));
  };
}

/** One send, timed from just before it leaves: headers, first byte, first content and end. */
export async function sendAttempt(
  context: CallContext,
  kind: LoadKind,
  traceId: string,
  attempt: number,
): Promise<Attempt> {
  const { client, clock, attemptTimeoutMs } = context;
  const path = paths[kind.shape];
  const { url, headers } = await client.authorized(context.credential, "POST", path);
  const startedAt = clock.wall();
  const started = clock.now();
  const since = () => clock.now() - started;
  const ended = (fields: Omit<Attempt, "attempt" | "startedAt" | "endedAt" | "totalMs">) => ({
    attempt,
    startedAt,
    endedAt: clock.wall(),
    totalMs: since(),
    ...fields,
  });
  let response: Response;
  try {
    response = await client.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Accept: kind.stream ? "text/event-stream" : "application/json",
          ...(kind.shape === "messages" ? { "anthropic-version": "2023-06-01" } : {}),
          // Not sampled: the pool logs the trace id on every call's wide event but exports no trace.
          traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-00`,
        },
        body: JSON.stringify(callBody(kind)),
      },
      path,
      attemptTimeoutMs,
    );
  } catch {
    const timedOut = since() >= attemptTimeoutMs;
    return ended({ end: timedOut ? "timeout" : "transport", retryable: !timedOut });
  }
  const answer = {
    status: response.status,
    requestId: header(response, "X-Request-Id", requestIdPattern),
    boot: header(response, "X-Signalbox-Pool-Boot", bootPattern),
    retryAfterMs: retryAfter(response.headers.get("Retry-After"), clock.wall()),
    headersMs: since(),
  };
  if (response.status !== 200) {
    const refusal = await readRefusal(response);
    // The pool's cap refusal is its owner's setting, not a pool that may serve on a second send.
    const capped = response.status === 429 && refusal?.code === "user_period_limit_exceeded";
    const retryable =
      !capped && (retryStatus(response.status) || answer.retryAfterMs !== undefined);
    return ended({ ...answer, refusal, end: "status", retryable });
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const probe = contentProbe(kind.shape);
  let text = "";
  let bytes = 0;
  let firstByteMs: number | undefined;
  let firstContentMs: number | undefined;
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value.byteLength) continue;
      firstByteMs ??= since();
      bytes += part.value.byteLength;
      if (bytes > bodyLimit) {
        await reader.cancel().catch(() => {});
        return ended({
          ...answer,
          firstByteMs,
          firstContentMs,
          end: "too_large",
          retryable: false,
        });
      }
      const chunk = decoder.decode(part.value, { stream: true });
      text += chunk;
      if (kind.stream && firstContentMs === undefined && probe(chunk)) firstContentMs = since();
    }
    text += decoder.decode();
  } catch {
    const end = since() >= attemptTimeoutMs ? "timeout" : "cut";
    return ended({ ...answer, firstByteMs, firstContentMs, end, retryable: false });
  }
  // An unstreamed answer's content is usable only once all of it has arrived.
  if (!kind.stream && firstByteMs !== undefined) firstContentMs = since();
  const verdict = callVerdict(kind, text);
  return ended({
    ...answer,
    firstByteMs,
    firstContentMs,
    verdict,
    end: "complete",
    retryable: false,
  });
}

export const servedClean = (attempt: Attempt) =>
  attempt.status === 200 && attempt.end === "complete" && attempt.verdict?.pass === true;

/** A call and every send it took: sent again only while the answer said so, up to the shape's bound. */
export async function sendCall(
  context: CallContext,
  kind: LoadKind,
  call: number,
  worker: number,
): Promise<CallRecord> {
  const traceId = randomBytes(16).toString("hex");
  const attempts: Attempt[] = [];
  for (let attempt = 1; ; attempt++) {
    const sent = await sendAttempt(context, kind, traceId, attempt);
    attempts.push(sent);
    if (servedClean(sent) || !sent.retryable || attempt >= context.maxAttempts) break;
    await context.clock.sleep(
      Math.min(retryAfterCapMs, sent.retryAfterMs ?? Math.min(8_000, 500 * 2 ** (attempt - 1))),
    );
  }
  return {
    call,
    worker,
    kind: kind.name,
    traceId,
    startedAt: attempts[0]!.startedAt,
    endedAt: attempts.at(-1)!.endedAt,
    attempts,
  };
}
