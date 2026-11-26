import type { Shape } from "./load-verdict.mjs";
import { isObject } from "./types.ts";

const bodyLimit = 4 * 1024 * 1024;

export interface StreamRead {
  readonly end: "complete" | "cut" | "timeout" | "too_large";
  /** The whole body, only when it was read to its end. */
  readonly text?: string;
  readonly firstByteMs?: number;
  /** The first frame that carries the answer's own text: what the mock's profile times. */
  readonly firstContentMs?: number;
  /** The longest wait between two data frames from the first content on. */
  readonly stallMs?: number;
}

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

/**
 * Times a stream's frames as their lines complete. A comment line (a keep-alive) is no progress, and
 * neither is a frame without text before the first content: a role frame or `message_start`.
 */
export function frameTimer(shape: Shape) {
  let pending = "";
  let firstContentMs: number | undefined;
  let lastFrameMs: number | undefined;
  let stallMs: number | undefined;
  return {
    /** The text that arrived at `atMs` since the send. */
    observe(chunk: string, atMs: number) {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      const frames = lines.filter((line) => line.startsWith("data:"));
      if (!frames.length) return;
      if (firstContentMs === undefined) {
        const content = frames.some((line) => frameHasContent(shape, line.slice(5).trimStart()));
        if (!content) return;
        firstContentMs = atMs;
      } else stallMs = Math.max(stallMs ?? 0, atMs - lastFrameMs!);
      lastFrameMs = atMs;
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
    text += decoder.decode();
  } catch {
    return { end: since() >= timeoutMs ? "timeout" : "cut", ...timings() };
  }
  // An unstreamed answer's content is usable only once all of it has arrived.
  if (!streamed && firstByteMs !== undefined)
    return { end: "complete", text, firstByteMs, firstContentMs: since() };
  return { end: "complete", text, ...timings() };
}
