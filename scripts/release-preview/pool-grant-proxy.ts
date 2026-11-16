import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export const previewModel = "claude-opus-5-5" as const;
const maxBodyBytes = 1024 * 1024;
const deny = (response: ServerResponse, status: number) => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: "Preview model request refused" }));
};
function authenticated(request: IncomingMessage, nonce: string) {
  const apiKey = request.headers["x-api-key"];
  const bearer = request.headers.authorization;
  const supplied = [apiKey, bearer?.startsWith("Bearer ") ? bearer.slice(7) : bearer].filter(
    (item) => item !== undefined,
  );
  return (
    supplied.length > 0 &&
    supplied.every(
      (item) =>
        typeof item === "string" &&
        Buffer.byteLength(item) === Buffer.byteLength(nonce) &&
        timingSafeEqual(Buffer.from(item), Buffer.from(nonce)),
    )
  );
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new Error("Preview request exceeds limit");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "model" in parsed &&
    parsed.model === previewModel
    ? text
    : undefined;
}

/** The native client receives only this loopback nonce; the pool key stays with its owner. */
export async function openPreviewModelProxy(
  forward: (body: string, version: string, signal: AbortSignal) => Promise<Response>,
) {
  const nonce = randomBytes(32).toString("hex");
  const controllers = new Set<AbortController>();
  let closed = false;
  const server = createServer(async (request, response) => {
    if (closed || !authenticated(request, nonce)) return deny(response, 401);
    if (request.method !== "POST" || request.url !== "/v1/messages") return deny(response, 404);
    const version = request.headers["anthropic-version"] ?? "2023-06-01";
    if (typeof version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(version))
      return deny(response, 400);
    const controller = new AbortController();
    controllers.add(controller);
    response.once("close", () => controller.abort());
    const timeout = setTimeout(() => controller.abort(), 120_000);
    timeout.unref();
    try {
      const text = await body(request);
      if (text === undefined) return deny(response, 400);
      const upstream = await forward(text, version, controller.signal);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return deny(
          response,
          upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
        );
      }
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      });
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
        }
      }
      response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else deny(response, 502);
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  });
  server.maxConnections = 4;
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Preview proxy unavailable");
  const origin = new URL("http://127.0.0.1");
  origin.port = String(address.port);
  return {
    modelUrl: origin.origin,
    modelKey: nonce,
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error ? reject(new Error("Preview proxy shutdown failed")) : resolve(),
        );
        server.closeAllConnections();
      });
    },
  };
}
