// The pinned load driver's pass rule for each stream shape (the daily proof's load driver, its
// `attempt`), so a check that passes here is a call the driver would pass. Stricter where the mock
// must be exact: every shape reports usage, ends on its own and counts the whole way. A call with
// `stream: false` is judged by the same rule on its one JSON answer.
import { LONG_COUNT, longPrompt, shortPrompt } from "./prompts.ts";

const MAX_TOKENS = 16;
const LONG_TOKENS = 4_000;
const INPUT_RESERVE = 500;

export const paths = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

export function requestBody(shape, long, { stream = true } = {}) {
  const prompt = long ? longPrompt : shortPrompt;
  const limit = long ? LONG_TOKENS : MAX_TOKENS;
  const model = "emulated-check";
  if (shape === "responses") return { model, max_output_tokens: limit, stream, input: prompt };
  const messages = [{ role: "user", content: prompt }];
  if (shape === "chat")
    return stream
      ? { model, max_tokens: limit, stream, stream_options: { include_usage: true }, messages }
      : { model, max_tokens: limit, stream, messages };
  return { model, max_tokens: limit, stream, messages };
}

// SSE makes the space after `data:` optional, and the pool's own stream observer reads both forms. A
// frame that is not a JSON object is an error here, as it is for the providers' SDKs.
const frames = (text) =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
    .filter((data) => data !== "[DONE]")
    .map((data) => {
      try {
        const frame = JSON.parse(data);
        if (frame && typeof frame === "object" && !Array.isArray(frame)) return frame;
      } catch {}
      return { type: "unparseable" };
    });

/** What one finished stream said: its text, whether it ended, its errors and its usage. */
function streamed(shape, text) {
  const all = frames(text);
  if (shape === "responses") {
    const end = all.findLast((f) =>
      /^response\.(completed|incomplete|failed)$/u.test(f.type ?? ""),
    );
    return {
      out: all
        .filter((f) => f.type === "response.output_text.delta")
        .map((f) => f.delta ?? "")
        .join(""),
      terminal: end?.type === "response.completed",
      errors: all.filter(
        (f) =>
          f.type === "error" || f.type === "unparseable" || f.type === "response.failed" || f.error,
      ),
      input: end?.response?.usage?.input_tokens,
      output: end?.response?.usage?.output_tokens,
    };
  }
  if (shape === "chat") {
    const usage = all.findLast((f) => f.usage)?.usage;
    return {
      out: all.map((f) => f.choices?.[0]?.delta?.content ?? "").join(""),
      terminal:
        all.some((f) => f.choices?.[0]?.finish_reason === "stop") &&
        /^data: \[DONE\]$/mu.test(text),
      errors: all.filter(
        (f) =>
          f.error ||
          f.type === "error" ||
          f.type === "unparseable" ||
          ["length", "content_filter"].includes(f.choices?.[0]?.finish_reason),
      ),
      input: usage?.prompt_tokens,
      output: usage?.completion_tokens,
    };
  }
  const stopReason = all.filter((f) => f.type === "message_delta").at(-1)?.delta?.stop_reason;
  const start = all.find((f) => f.type === "message_start")?.message?.usage;
  const delta = all.filter((f) => f.type === "message_delta" && f.usage).at(-1)?.usage;
  return {
    out: all
      .filter((f) => f.type === "content_block_delta" && f.delta?.type === "text_delta")
      .map((f) => f.delta.text)
      .join(""),
    terminal:
      all.filter((f) => f.type === "message_stop").length === 1 &&
      all.filter((f) => f.type === "message_start").length === 1 &&
      ["end_turn", "max_tokens"].includes(stopReason),
    errors: all.filter((f) => f.type === "error" || f.type === "unparseable" || f.error),
    input: start?.input_tokens ?? delta?.input_tokens,
    output: delta?.output_tokens ?? start?.output_tokens,
  };
}

const list = (value) => (Array.isArray(value) ? value : []);

/** What one JSON answer said, read the way `streamed` reads a stream of the same shape. */
function whole(shape, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!body || typeof body !== "object" || Array.isArray(body)) return { unreadable: true };
  const errors = body.error || body.type === "error" ? [body] : [];
  if (shape === "responses")
    return {
      out: list(body.output)
        .filter((item) => item?.type === "message")
        .flatMap((item) => list(item.content))
        .filter((part) => part?.type === "output_text")
        .map((part) => part.text ?? "")
        .join(""),
      terminal: body.object === "response" && body.status === "completed",
      errors,
      input: body.usage?.input_tokens,
      output: body.usage?.output_tokens,
    };
  if (shape === "chat") {
    const choice = list(body.choices)[0];
    return {
      out: choice?.message?.content ?? "",
      terminal: body.object === "chat.completion" && choice?.finish_reason === "stop",
      errors,
      input: body.usage?.prompt_tokens,
      output: body.usage?.completion_tokens,
    };
  }
  return {
    out: list(body.content)
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
    terminal: body.type === "message" && ["end_turn", "max_tokens"].includes(body.stop_reason),
    errors,
    input: body.usage?.input_tokens,
    output: body.usage?.output_tokens,
  };
}

/**
 * The driver's verdict on one finished call, with the reason when it fails: a stream by default,
 * or with `{ stream: false }` the one JSON answer a call made with `requestBody`'s same option.
 */
export function verdict(shape, long, text, { stream = true } = {}) {
  const read = stream ? streamed(shape, text) : whole(shape, text);
  if (read.unreadable) return { pass: false, reason: "not a JSON answer" };
  const { terminal, errors, input, output } = read;
  // A content field of the wrong type is a failed answer, never a thrown verdict.
  const out = typeof read.out === "string" ? read.out : "";
  const lines = out.trim().split(/\r?\n/u);
  const content = long
    ? lines.length === LONG_COUNT && lines.every((line, index) => line === String(index + 1))
    : out.trim() === "OK";
  const usage = typeof input === "number" && typeof output === "number";
  const withinTokens =
    usage && output <= (long ? LONG_TOKENS : MAX_TOKENS) && input <= INPUT_RESERVE;
  const reason = !terminal
    ? "no terminal event"
    : errors.length
      ? "error event"
      : !content
        ? "content not exact"
        : !usage
          ? "usage missing"
          : !withinTokens
            ? "usage over the reserve"
            : undefined;
  return { pass: reason === undefined, reason, input, output };
}
