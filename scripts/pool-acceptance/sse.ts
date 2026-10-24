import { AcceptanceFailure, isObject } from "./types.ts";

const defaultMaxStreamBytes = 2 * 1024 * 1024;

function containsText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(containsText);
  return isObject(value) && typeof value.text === "string" && value.text.trim().length > 0;
}

export async function verifySse(
  response: Response,
  requestStarted: number,
  options: { readonly now?: () => number; readonly maxBytes?: number } = {},
): Promise<{ firstByteMs: number; totalMs: number }> {
  const now = options.now ?? (() => performance.now());
  const maxBytes = options.maxBytes ?? defaultMaxStreamBytes;
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new AcceptanceFailure(`/v1/chat/completions returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/event-stream") {
    await response.body?.cancel().catch(() => undefined);
    throw new AcceptanceFailure("/v1/chat/completions did not return text/event-stream");
  }
  if (!response.body) throw new AcceptanceFailure("/v1/chat/completions returned an empty stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  let firstByteMs: number | undefined;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AcceptanceFailure(`SSE response exceeded the ${maxBytes} byte acceptance limit`);
      }
      if (firstByteMs === undefined && part.value.byteLength > 0) {
        firstByteMs = now() - requestStarted;
      }
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    throw new AcceptanceFailure("Could not read the SSE response");
  } finally {
    reader.releaseLock();
  }

  let sawDone = false;
  let sawText = false;
  let dataEvents = 0;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (!data) continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new AcceptanceFailure("SSE response contained invalid event JSON");
    }
    dataEvents += 1;
    if (!isObject(event) || !Array.isArray(event.choices)) continue;
    for (const choice of event.choices) {
      if (!isObject(choice)) continue;
      if (containsText(choice.text) || (isObject(choice.delta) && containsText(choice.delta.content))) {
        sawText = true;
      }
    }
  }
  if (!sawDone || dataEvents === 0 || !sawText || firstByteMs === undefined) {
    throw new AcceptanceFailure("SSE response lacked generated text or the [DONE] event");
  }
  return { firstByteMs, totalMs: now() - requestStarted };
}
