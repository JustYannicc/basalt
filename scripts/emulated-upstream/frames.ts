// Which frames of a stream add text to the answer the pass rule judges, and when they came. The load
// driver times its reads with it and the mock times its sends with it, so the two witnesses of a
// call's timing read its frames the same way.
export type Shape = "chat" | "responses" | "messages";

type Frame = Record<string, unknown> | null;
// What `Array.prototype.join` makes of a value, which is how the pass rule builds its text. A value
// this join cannot turn into text (one with no string form, or one nested too deep for its stack)
// adds no text here. The pass rule still decides whether the content is right, and a call whose
// content was never timed is judged by its whole wait, so this never makes a call look early.
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
 * The text one frame adds to the answer the pass rule judges. This is the rule's own reading
 * (shapes.mjs): lines that start `data:`, with or without the space, skipping `[DONE]`, reading an
 * unparseable frame as nothing, and joining these fields. A rule that reads more than this leaves
 * frames untimed, which only makes a call look later.
 */
export function frameText(shape: Shape, line: string) {
  if (!line.startsWith("data:")) return "";
  const data = line.slice(line.startsWith("data: ") ? 6 : 5);
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

/** Whether one line is the stream's own terminal event, the frame a client stops reading at. */
export function isTerminal(shape: Shape, line: string) {
  if (!line.startsWith("data:")) return false;
  const data = line.slice(line.startsWith("data: ") ? 6 : 5);
  if (shape === "chat") return data === "[DONE]";
  let frame: Frame;
  try {
    frame = JSON.parse(data) as Frame;
  } catch {
    return false;
  }
  return read(frame, "type") === (shape === "responses" ? "response.completed" : "message_stop");
}

/**
 * Times a stream by the frames that add text to the judged answer, as their lines complete. Text
 * that trims to nothing is no content, so a ping, an empty delta or a space neither starts the
 * answer nor ends a stall. It also notes when the stream's terminal event passed.
 */
export function frameTimer(shape: Shape) {
  let pending = "";
  let firstContentMs: number | undefined;
  let lastContentMs: number | undefined;
  let stallMs: number | undefined;
  let terminalMs: number | undefined;
  const line = (text: string, atMs: number) => {
    if (terminalMs === undefined && isTerminal(shape, text)) terminalMs = atMs;
    if (!frameText(shape, text).trim()) return;
    if (lastContentMs === undefined) firstContentMs = atMs;
    else stallMs = Math.max(stallMs ?? 0, atMs - lastContentMs);
    lastContentMs = atMs;
  };
  return {
    /** The text that arrived at `atMs`. */
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
    /** When the stream's terminal event's line completed; undefined until it has. */
    get terminalMs() {
      return terminalMs;
    },
  };
}
