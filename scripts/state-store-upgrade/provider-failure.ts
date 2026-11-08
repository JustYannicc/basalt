export interface ProviderMessage {
  code?: number;
  message: string;
}
export interface ProviderFailure {
  body: "json" | "invalid-json" | "too-large" | "unavailable";
  errors: ProviderMessage[];
  messages: ProviderMessage[];
  omitted: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sanitize = (value: string, token: string) => {
  const text = token ? value.replaceAll(token, "[REDACTED]") : value;
  return text
    .replace(/bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/(?:https?:\/\/|file:\/\/)[^\s"'<>]+/gi, "[URL]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(
      /["']?\b(?:authorization|(?:set-)?cookie)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
      "[CREDENTIAL]",
    )
    .replace(
      /["']?\b(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      "[CREDENTIAL]",
    )
    .replace(/\b[A-Za-z0-9_+/-]{24,}={0,2}\b/g, "[REDACTED]")
    .replace(/[\p{Cc}<>`]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
};
export function envelopeFailure(value: unknown, token: string): ProviderFailure {
  let omitted = 0;
  const rows = (items: unknown): ProviderMessage[] => {
    if (!Array.isArray(items)) return [];
    omitted += Math.max(0, items.length - 8);
    return items.slice(0, 8).flatMap((item) => {
      const row = typeof item === "string" ? { message: item } : record(item) ? item : {};
      const code =
        Number.isSafeInteger(row.code) && Number(row.code) >= 0 && Number(row.code) < 1e9
          ? Number(row.code)
          : undefined;
      const message = typeof row.message === "string" ? sanitize(row.message, token) : "";
      return code === undefined && !message
        ? []
        : [{ ...(code === undefined ? {} : { code }), message }];
    });
  };
  const body = record(value) ? value : {};
  return { body: "json", errors: rows(body.errors), messages: rows(body.messages), omitted };
}

/** Error responses can echo request data. Bound bytes before decoding and retain only safe envelope fields. */
export async function responseFailure(response: Response, token: string): Promise<ProviderFailure> {
  const empty = (body: ProviderFailure["body"]): ProviderFailure => ({
    body,
    errors: [],
    messages: [],
    omitted: 0,
  });
  if (!response.body) return empty("unavailable");
  const reader = response.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) return empty("too-large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return envelopeFailure(JSON.parse(text), token);
    } catch {
      return empty("invalid-json");
    }
  } catch {
    return empty("unavailable");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
