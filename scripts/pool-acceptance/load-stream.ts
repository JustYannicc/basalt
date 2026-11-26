import type { Shape } from "./load-verdict.mjs";

const bodyLimit = 4 * 1024 * 1024;

export interface StreamRead {
  readonly end: "complete" | "cut" | "timeout" | "too_large";
  /** The whole body, only when it was read to its end. */
  readonly text?: string;
  readonly firstByteMs?: number;
  /** When the first frame that adds text to the pass rule's answer arrived. */
  readonly firstContentMs?: number;
  /**
   * The longest wait between two frames that add text, and from the last of them to the body's
   * end: a stall, whatever pings, empty deltas or comments came between.
   */
  readonly stallMs?: number;
}

type Frame = Record<string, unknown> | null;
// What `Array.prototype.join` makes of a value, which is how the pass rule builds its text. A value
// with no string form throws there too, so the pass rule fails the call; here it adds no text,
// which never makes a call look early.
const joined = (value: unknown) => {
  try {
    return [value].join("");
  } catch {
    return "";
  }
};
const read = (value: unknown, key: string) =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * The text one frame adds to the answer the pass rule judges. This is the rule's own reading,
 * line for line: scripts/emulated-upstream/shapes.mjs keeps lines that start `data: ` (with the
 * space), skips `[DONE]`, reads an unparseable frame as nothing, and joins these fields. It is
 * mirrored because that module exports no reading of its own; a rule that reads more than this
 * leaves frames untimed, which only makes a call look later.
 */
export function frameText(shape: Shape, line: string) {
  if (!line.startsWith("data: ")) return "";
  const data = line.slice(6);
  if (data === "[DONE]") return "";
  let frame: Frame;
  try {
    frame = JSON.parse(data) as Frame;
  } catch {
    return "";
  }
  const type = read(frame, "type");
  const delta = read(frame, "delta");
  if (shape === "responses")
    return type === "response.output_text.delta" ? joined(delta ?? "") : "";
  if (shape === "messages")
    return type === "content_block_delta" && read(delta, "type") === "text_delta"
      ? joined(read(delta, "text"))
      : "";
  return joined(read(read(read(read(frame, "choices"), "0"), "delta"), "content") ?? "");
}

/**
 * Times a stream by the frames that add text to the judged answer, as their lines complete. Text
 * that trims to nothing is no content, so a ping, an empty delta or a space neither starts the
 * answer nor ends a stall.
 */
export function frameTimer(shape: Shape) {
  let pending = "";
  let firstContentMs: number | undefined;
  let lastContentMs: number | undefined;
  let stallMs: number | undefined;
  const line = (text: string, atMs: number) => {
    if (!frameText(shape, text).trim()) return;
    if (lastContentMs === undefined) firstContentMs = atMs;
    else stallMs = Math.max(stallMs ?? 0, atMs - lastContentMs);
    lastContentMs = atMs;
  };
  return {
    /** The text that arrived at `atMs` since the send. */
    observe(chunk: string, atMs: number) {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const text of lines) line(text, atMs);
    },
    /** The body ended at `atMs`: its last line counts though it had no line ending, and so does the wait. */
    end(atMs: number) {
      line(pending, atMs);
      pending = "";
      if (lastContentMs !== undefined) stallMs = Math.max(stallMs ?? 0, atMs - lastContentMs);
    },
    get firstContentMs() {
      return firstContentMs;
    },
    get stallMs() {
      return stallMs;
    },
  };
}

/** Reads a 200's body to its end or its break, timing it on `since`, the send's own clock. */
export async function readStream(
  response: Response,
  shape: Shape,
  streamed: boolean,
  since: () => number,
  timeoutMs: number,
): Promise<StreamRead> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const timer = frameTimer(shape);
  let text = "";
  let bytes = 0;
  let firstByteMs: number | undefined;
  const timings = () => ({
    firstByteMs,
    firstContentMs: timer.firstContentMs,
    stallMs: timer.stallMs,
  });
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value.byteLength) continue;
      const atMs = since();
      firstByteMs ??= atMs;
      bytes += part.value.byteLength;
      if (bytes > bodyLimit) {
        await reader.cancel().catch(() => {});
        return { end: "too_large", ...timings() };
      }
      const chunk = decoder.decode(part.value, { stream: true });
      text += chunk;
      if (streamed) timer.observe(chunk, atMs);
    }
  } catch {
    return { end: since() >= timeoutMs ? "timeout" : "cut", ...timings() };
  }
  const endedMs = since();
  const tail = decoder.decode();
  text += tail;
  // An unstreamed answer's content is usable only once all of it has arrived.
  if (!streamed) return { end: "complete", text, firstByteMs, firstContentMs: endedMs };
  timer.observe(tail, endedMs);
  timer.end(endedMs);
  return { end: "complete", text, ...timings() };
}
