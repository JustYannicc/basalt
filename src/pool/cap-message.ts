import { object } from "./json.ts";

const maxBytes = 8192;
/** Model calls: the paths whose refusals carry a cap and whose successes count as usage. */
export const modelPaths = new Set(["/v1/messages", "/messages", "/v1/responses", "/v1/chat/completions", "/chat/completions", "/v1/completions", "/completions"]);
export const capMessage = "You've reached the weekly cap this pool's owner set for you. It resets Monday 00:00 UTC. Ask them to raise it, or switch this computer to another pool.";

/** Inspect only bounded JSON refusals. Successful bodies and SSE are never read. */
export async function rewriteCapResponse(response: Response, pathname: string): Promise<Response> {
  if (!modelPaths.has(pathname) || response.status !== 429 || !response.body
    || !/^application\/(?:json|[^;\s]+\+json)(?:;|$)/i.test(response.headers.get("Content-Type") ?? "")) return response;
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return response;
  const copy = response.clone();
  const reader = copy.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Error body read timed out")), 1000); });
    for (;;) {
      const part = await Promise.race([reader.read(), expired]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) return response;
      chunks.push(part.value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    // Home v1.1.6 internal/cluster/user_period_limit.go:651-664 formats this message.
    // Node v8.0.40 sdk/cliproxy/auth/home_concurrency.go:256-259 maps it to 429;
    // sdk/cliproxy/auth/errors.go:80-97 preserves the type prefix. Provider 429s stay untouched.
    if (!object(body) || !object(body.error) || typeof body.error.message !== "string"
      || !body.error.message.startsWith("user_period_limit_exceeded: period limit exceeded (window=7d mode=calendar used=")) return response;
    // Node v8.0.40 sdk/api/handlers/handlers.go:123-153 and
    // sdk/api/handlers/claude/code_handlers.go:535-622 define these protocol error shapes.
    const anthropic = pathname === "/v1/messages" || pathname === "/messages";
    const headers = new Headers(response.headers);
    for (const name of ["Content-Length", "Content-Encoding", "ETag"]) headers.delete(name);
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(anthropic
      ? { type: "error", error: { type: "rate_limit_error", message: capMessage } }
      : { error: { message: capMessage, type: "rate_limit_error", code: "user_period_limit_exceeded" } }),
    { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A tee's cancellation waits for the other branch; never hold up the original response.
    void reader.cancel().catch(() => {});
  }
}
