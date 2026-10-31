import type { CredentialSource } from "../contracts/connection.ts";
import { decodeTunnelFrame } from "../contracts/tunnel.ts";
import type { OpenOperation } from "../contracts/transport.ts";

/** Native requests stay on the grant's tunnel and are never retried here. */
export async function cloudRequest(
  source: CredentialSource,
  request: OpenOperation,
  body: string | undefined,
  signal: AbortSignal,
) {
  const checked = decodeTunnelFrame(
    JSON.stringify({ v: 1, type: "open", id: 1, ...request }),
    "client",
  );
  if (checked.type !== "open" || checked.operation.transport !== "http")
    throw new Error("Expected a native HTTP operation.");
  if (body !== undefined && checked.operation.method !== "POST")
    throw new Error("This request takes no body.");
  const transport = await source.transport(signal);
  if (transport.mode !== "device" || !transport.capabilities.includes(checked.operation.service))
    throw new Error("This device cannot use that service.");
  signal.throwIfAborted();
  const remote = transport.open(checked, signal);
  const upload = (async () => {
    if (body !== undefined) await remote.send(new TextEncoder().encode(body));
    await remote.end();
  })();
  void upload.catch(() => remote.close());
  try {
    const response = await remote.response;
    const chunks = async function* () {
      try {
        for (;;) {
          const part = await remote.next();
          if (!part) break;
          yield part.bytes;
          remote.consumed(part.bytes.length);
        }
        await upload;
      } finally {
        remote.close();
      }
    };
    return {
      ...response,
      chunks,
      close: () => remote.close(),
      json: async (): Promise<unknown> => {
        let text = "",
          size = 0;
        const decoder = new TextDecoder();
        for await (const chunk of chunks()) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new Error("The server response is too large.");
          text += decoder.decode(chunk, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
      },
    };
  } catch (error) {
    remote.close();
    throw error;
  }
}

/** Decode SSE across arbitrary UTF-8 chunks, including CRLF and multiline data. */
export async function* serverEvents(chunks: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    size = 0;
  const line = (value: string) => {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /u, ""));
    }
    if (value !== "") return undefined;
    const event = data.length ? data.join("\n") : undefined;
    data = [];
    size = 0;
    return event;
  };
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const value = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      size += value.length;
      if (size > 1024 * 1024) throw new Error("The streamed event is too large.");
      const event = line(value);
      if (event !== undefined) yield event;
    }
    if (size + buffer.length > 1024 * 1024) throw new Error("The streamed event is too large.");
  }
  buffer += decoder.decode();
  if (buffer || data.length) throw new Error("The event stream ended mid-event.");
}
