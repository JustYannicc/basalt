import { signEnvelope } from "../pool/token.ts";
import type { SetupEnv } from "./host.ts";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
async function bounded(stream: ReadableStream<Uint8Array> | null): Promise<string | undefined> {
  if (!stream) return;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = setTimeout(() => { void reader.cancel(); }, 5_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) { void reader.cancel(); return; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}

/** Observe only a successful MCP tools/call result; never retain tool arguments or output. */
export async function observeToolCall(request: Request, response: Response, env: SetupEnv): Promise<void> {
  try {
    const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token || !response.ok) return;
    const raw = await bounded(request.body);
    const call: unknown = raw ? JSON.parse(raw) : null;
    if (!object(call) || call.method !== "tools/call" || call.id === undefined || !object(call.params)
      || typeof call.params.name !== "string") return;
    const output = await bounded(response.body);
    if (!output) return;
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? output.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [output];
    const success = messages.some((message) => {
      try {
        const reply: unknown = JSON.parse(message);
        return object(reply) && reply.id === call.id && !reply.error && object(reply.result)
          && reply.result.isError !== true && Array.isArray(reply.result.content);
      } catch { return false; }
    });
    if (!success) return;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const tokenHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const envelope = await signEnvelope(env.POOL_APP_SIGNING_KEY, "sbs1", { action: "observed", tokenHash, expiresAt: Date.now() + 30_000 });
    const recorded = await env.POOL_SERVICE.fetch(new Request(new URL("/__setup/v1/observed", request.url), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envelope }),
    }));
    await recorded.body?.cancel();
  } catch { /* A failed observation leaves the computer waiting for its next tool call. */ }
}
