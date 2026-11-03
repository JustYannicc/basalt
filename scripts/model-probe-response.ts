/** Self-contained so the live probe can pass this function into its browser evaluation. */
export async function captureModelProbeResponse(response: Response) {
  const limit = 16_384;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let readFailed = false;
  const deadline = setTimeout(() => {
    readFailed = true;
    void reader?.cancel().catch(() => {});
  }, 5_000);
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit + 1 - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (size > limit) {
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    readFailed = true;
  } finally {
    clearTimeout(deadline);
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const sensitive = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|headers|[\w-]*(?:secret|password|credential|envelope|key|token))$/i;
  const scrub = (text: string) => text
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>,;]+/gi, "<REDACTED>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|sb-app-model1\S*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?)/g, "<REDACTED>")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<REDACTED>@")
    .replace(/\b((?:set-cookie|cookie)\s*:)\s*[^\r\n]*/gi, "$1 <REDACTED>")
    .replace(/(["']?headers["']?\s*[:=]\s*)[[{][\s\S]*/gi, "$1\"<REDACTED>\"")
    .replace(/(["']?(?:[\w-]*(?:secret|password|credential|envelope|key|token)|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,;}\]]+)/gi, "$1\"<REDACTED>\"");
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        sensitive.test(key) ? "<REDACTED>" : redact(item),
      ]));
    return value;
  };
  const raw = new TextDecoder().decode(bytes);
  let body: string;
  try { body = JSON.stringify(redact(JSON.parse(raw))); }
  catch { body = scrub(raw); }
  const sanitized = new TextEncoder().encode(body);
  if (sanitized.byteLength > limit) truncated = true;
  return {
    status: response.status,
    ok: response.ok,
    body: new TextDecoder().decode(sanitized.subarray(0, limit), { stream: true }),
    truncated,
    readFailed,
  };
}
