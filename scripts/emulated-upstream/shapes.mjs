// The pinned load driver's pass rule for each stream shape (the daily proof's load driver, its
// `attempt`), so a check that passes here is a call the driver would pass. Stricter where the mock
// must be exact: every shape reports usage, ends on its own and counts the whole way.
import { LONG_COUNT, longPrompt, shortPrompt } from "./prompts.ts";

const MAX_TOKENS = 16;
const LONG_TOKENS = 4_000;
const INPUT_RESERVE = 500;

export const paths = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

export function requestBody(shape, long) {
  const prompt = long ? longPrompt : shortPrompt;
  const limit = long ? LONG_TOKENS : MAX_TOKENS;
  const model = "emulated-check";
  if (shape === "responses")
    return { model, max_output_tokens: limit, stream: true, input: prompt };
  const messages = [{ role: "user", content: prompt }];
  if (shape === "chat")
    return {
      model,
      max_tokens: limit,
      stream: true,
      stream_options: { include_usage: true },
      messages,
    };
  return { model, max_tokens: limit, stream: true, messages };
}

const frames = (text) =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return { type: "unparseable" };
      }
    });

/** The driver's verdict on one finished stream, with the reason when it fails. */
export function verdict(shape, long, text) {
  const all = frames(text);
  let out = "";
  let terminal = false;
  let errors = [];
  let input;
  let output;
  if (shape === "responses") {
    out = all
      .filter((f) => f.type === "response.output_text.delta")
      .map((f) => f.delta ?? "")
      .join("");
    const end = all.findLast((f) =>
      /^response\.(completed|incomplete|failed)$/u.test(f.type ?? ""),
    );
    terminal = end?.type === "response.completed";
    errors = all.filter((f) => f.type === "error" || f.type === "response.failed" || f.error);
    input = end?.response?.usage?.input_tokens;
    output = end?.response?.usage?.output_tokens;
  } else if (shape === "chat") {
    out = all.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");
    terminal =
      all.some((f) => f.choices?.[0]?.finish_reason === "stop") && /^data: \[DONE\]$/mu.test(text);
    errors = all.filter(
      (f) =>
        f.error ||
        f.type === "error" ||
        ["length", "content_filter"].includes(f.choices?.[0]?.finish_reason),
    );
    const usage = all.findLast((f) => f.usage)?.usage;
    input = usage?.prompt_tokens;
    output = usage?.completion_tokens;
  } else {
    out = all
      .filter((f) => f.type === "content_block_delta" && f.delta?.type === "text_delta")
      .map((f) => f.delta.text)
      .join("");
    const stopReason = all.filter((f) => f.type === "message_delta").at(-1)?.delta?.stop_reason;
    terminal =
      all.filter((f) => f.type === "message_stop").length === 1 &&
      all.filter((f) => f.type === "message_start").length === 1 &&
      ["end_turn", "max_tokens"].includes(stopReason);
    errors = all.filter((f) => f.type === "error" || f.error);
    const start = all.find((f) => f.type === "message_start")?.message?.usage;
    const delta = all.filter((f) => f.type === "message_delta" && f.usage).at(-1)?.usage;
    input = start?.input_tokens ?? delta?.input_tokens;
    output = delta?.output_tokens ?? start?.output_tokens;
  }
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
