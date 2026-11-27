import { frameTimer, type Shape } from "../emulated-upstream/frames.ts";

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
