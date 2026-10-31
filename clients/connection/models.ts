import { Schema } from "effect";
import type { CredentialSource } from "../contracts/connection.ts";
import { cloudRequest, serverEvents } from "./request.ts";

const readModels = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) }),
);
const readDelta = Schema.decodeUnknownSync(
  Schema.Struct({
    choices: Schema.Array(
      Schema.Struct({
        delta: Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
      }),
    ),
  }),
);
export async function availableModels(source: CredentialSource, signal: AbortSignal) {
  const response = await cloudRequest(
    source,
    {
      operation: { service: "models", method: "GET", path: "/v1/models", transport: "http" },
      headers: { accept: "application/json" },
    },
    undefined,
    signal,
  );
  try {
    if (response.status !== 200) throw new Error(`Model discovery failed (${response.status}).`);
    return readModels(await response.json()).data.map((model) => model.id);
  } finally {
    response.close();
  }
}
export async function tryModel(
  source: CredentialSource,
  model: string,
  prompt: string,
  signal: AbortSignal,
  update: (text: string) => void,
) {
  if (!model || !prompt.trim()) throw new Error("Choose a model and enter a message.");
  const response = await cloudRequest(
    source,
    {
      operation: {
        service: "models",
        method: "POST",
        path: "/v1/chat/completions",
        transport: "http",
      },
      headers: { "content-type": "application/json", accept: "text/event-stream" },
    },
    JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true }),
    signal,
  );
  let result = "";
  try {
    if (response.status !== 200) throw new Error(`The model request failed (${response.status}).`);
    if (!response.headers["content-type"]?.startsWith("text/event-stream"))
      throw new Error("The model did not return a stream.");
    for await (const event of serverEvents(response.chunks())) {
      if (event === "[DONE]") return result;
      const delta = readDelta(JSON.parse(event));
      for (const choice of delta.choices) result += choice.delta.content ?? "";
      if (result.length > 128_000) throw new Error("The reply reached this screen's limit.");
      update(result);
    }
    throw new Error("The model stream ended before completion. It was not replayed.");
  } finally {
    response.close();
  }
}
