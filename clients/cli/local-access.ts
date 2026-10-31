import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Agent, Capability } from "../contracts/connection.ts";

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function tokenMatches(value: string | undefined, hash: string): boolean {
  return (
    value !== undefined &&
    /^[a-f0-9]{64}$/u.test(hash) &&
    timingSafeEqual(Buffer.from(tokenHash(value), "hex"), Buffer.from(hash, "hex"))
  );
}
export const bearerToken = (request: IncomingMessage) =>
  /^Bearer ([a-zA-Z0-9_-]{32,128})$/u.exec(request.headers.authorization ?? "")?.[1];

/** Both listeners enforce credentials; the TCP listener also rejects browser and proxy confusion. */
export function localRequest(request: IncomingMessage, authority: string): boolean {
  const host = request.headers.host;
  const origin = request.headers.origin;
  const originUrl = origin === undefined ? undefined : URL.parse(origin);
  const path = request.url;
  const singular = ["host", "authorization", "origin"];
  for (const name of singular) {
    let count = 0;
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      if (request.rawHeaders[i]?.toLowerCase() === name) count++;
    if (count > 1) return false;
  }
  if (
    Object.keys(request.headers).some(
      (name) => name === "forwarded" || name.startsWith("x-forwarded-"),
    )
  )
    return false;
  return (
    host === authority &&
    (origin === undefined ||
      (originUrl?.protocol === "http:" &&
        originUrl.host === authority &&
        origin === originUrl.origin)) &&
    path !== undefined &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !/[\u0000-\u0020\u007f]/u.test(path)
  );
}

export function findAgent(
  request: IncomingMessage,
  agents: readonly Agent[],
  capability: Capability,
) {
  const token = bearerToken(request);
  return agents.find(
    (agent) => tokenMatches(token, agent.tokenHash) && agent.capabilities.includes(capability),
  );
}

/** The local gateway exposes inference and MCP, never a general-purpose HTTP forwarder. */
export function remoteOperation(method: string | undefined, path: string): Capability | undefined {
  if (path === "/mcp" && ["POST", "GET", "DELETE"].includes(method ?? "")) return "tools";
  const url = URL.parse(path, "http://localhost");
  if (!url || url.search || url.hash) return undefined;
  if (method === "GET" && url.pathname === "/v1/models") return "models";
  if (
    method === "POST" &&
    [
      "/v1/responses",
      "/v1/responses/compact",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/completions",
      "/v1/embeddings",
    ].includes(url.pathname)
  )
    return "models";
  return undefined;
}
