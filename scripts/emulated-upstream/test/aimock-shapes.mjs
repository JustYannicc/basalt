// The answers the pinned aimock 1.48.1 image sends for the stage's fixtures, captured on 2026-11-26
// from the image run locally without a network. Builders change only the text and usage a test is
// about; ids, timestamps and every other field are the captured ones.

/** Server-sent events as aimock writes them: an optional `event:` line, then `data:`. */
export const sse = (events) =>
  events
    .map(
      ([event, data]) =>
        `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("");

const chunk = (choice, extra = {}) => ({
  id: "chatcmpl-tL7XeSNeQEkRgqyR",
  object: "chat.completion.chunk",
  created: 1795694282,
  model: "emulated-check",
  choices: choice ? [{ index: 0, logprobs: null, ...choice }] : [],
  ...extra,
});
const responseBody = (status, output, usage) => ({
  id: "resp-tBq8g7qL0chzh9Yz",
  object: "response",
  created_at: 1795694283,
  model: "emulated-check",
  status,
  output,
  ...(usage ? { usage } : {}),
});
const outputMessage = (text) => ({
  type: "message",
  id: "msg-aiP-bbGrJ_011l3U",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

/** One streamed answer in `shape` whose text is `text`. */
export function streamOf(shape, text, { input = 11, output = 2 } = {}) {
  if (shape === "chat")
    return sse([
      ["", chunk({ delta: { role: "assistant", content: "" }, finish_reason: null })],
      ["", chunk({ delta: { content: text }, finish_reason: null })],
      ["", chunk({ delta: {}, finish_reason: "stop" })],
      [
        "",
        chunk(undefined, {
          usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
        }),
      ],
      ["", "[DONE]"],
    ]);
  if (shape === "responses") {
    const item = "msg-aiP-bbGrJ_011l3U";
    const part = { item_id: item, output_index: 0, content_index: 0 };
    const textPart = (value) => ({ type: "output_text", text: value, annotations: [] });
    return sse([
      ["response.created", { type: "response.created", response: responseBody("in_progress", []) }],
      [
        "response.in_progress",
        { type: "response.in_progress", response: responseBody("in_progress", []) },
      ],
      [
        "response.output_item.added",
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...outputMessage(""), status: "in_progress", content: [] },
        },
      ],
      [
        "response.content_part.added",
        { type: "response.content_part.added", ...part, part: textPart("") },
      ],
      ["response.output_text.delta", { type: "response.output_text.delta", ...part, delta: text }],
      ["response.output_text.done", { type: "response.output_text.done", ...part, text }],
      [
        "response.content_part.done",
        { type: "response.content_part.done", ...part, part: textPart(text) },
      ],
      [
        "response.output_item.done",
        { type: "response.output_item.done", output_index: 0, item: outputMessage(text) },
      ],
      [
        "response.completed",
        {
          type: "response.completed",
          response: responseBody("completed", [outputMessage(text)], {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
          }),
        },
      ],
    ]);
  }
  return sse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_Yrq4pmsKdU2Y-pAO",
          type: "message",
          role: "assistant",
          content: [],
          model: "emulated-check",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: input, output_tokens: output },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: output },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

/** One answer to a call with `stream: false` in `shape`, as its JSON text. */
export function wholeOf(shape, text, { input = 11, output = 2 } = {}) {
  if (shape === "chat")
    return JSON.stringify({
      id: "chatcmpl-P-0wGBHr0NNvu0iB",
      object: "chat.completion",
      created: 1795693701,
      model: "emulated-check",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text, refusal: null },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    });
  if (shape === "responses")
    return JSON.stringify({
      ...responseBody("completed", [{ ...outputMessage(text), id: "msg-hHr8KJH0ubBT8EY9" }], {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
      }),
      id: "resp-5KxtYFbnDaAZv8YQ",
    });
  return JSON.stringify({
    id: "msg_kYiegjkUz9uHAuPi",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "emulated-check",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output },
  });
}

/** The chaos 429 aimock writes on every shape: an OpenAI error body, a 1 s retry, reset headers. */
export const chaos429Body = JSON.stringify({
  error: {
    message: "Chaos: rate limit exceeded",
    type: "rate_limit_error",
    code: "chaos_ratelimit",
  },
});
export const chaos429Headers = {
  "content-type": "application/json",
  "retry-after": "1",
  "x-ratelimit-limit-requests": "60",
  "x-ratelimit-limit-tokens": "150000",
  "x-ratelimit-remaining-requests": "0",
  "x-ratelimit-remaining-tokens": "0",
  "x-ratelimit-reset-requests": "1s",
  "x-ratelimit-reset-tokens": "6m0s",
  "x-request-id": "req-yYVNMIyC6kyKDemb",
};
