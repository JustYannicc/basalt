import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Capability, ServiceCredentials } from "../contracts/connection.ts";
import { normalizeModelSearch } from "../contracts/tunnel.ts";

const requestHeaders = new Set([
  "accept",
  "content-type",
  "content-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
]);
const responseHeaderNames = new Set([
  "content-type",
  "content-encoding",
  "content-length",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
  "retry-after",
  "x-request-id",
  "request-id",
]);
export const maximumRequestBytes = 16 * 1024 * 1024;

export function* forwardedResponseHeaders(headers: IncomingHttpHeaders) {
  for (const [name, value] of Object.entries(headers))
    if (responseHeaderNames.has(name) && value !== undefined) yield [name, value] as const;
}

function bodyLimit() {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(
        bytes > maximumRequestBytes ? new Error("The request exceeds the local size limit.") : null,
        chunk,
      );
    },
  });
}

/** Node pipes bound buffering and propagate a downstream disconnect without replaying a request. */
export async function forwardHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  service: NonNullable<ServiceCredentials[Capability]>,
  capability: Capability,
  signal: AbortSignal,
): Promise<void> {
  const target = new URL(
    capability === "tools" && "path" in service ? service.path : (incoming.url ?? "/"),
    service.origin,
  );
  if (capability === "models" && target.search) target.search = normalizeModelSearch(target.search);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers))
    if (requestHeaders.has(name) && value !== undefined) headers[name] = value;
  headers.authorization = `Bearer ${service.token}`;
  headers["accept-encoding"] = "identity";
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    let responseArrived = false;
    const remote = transport(target, { method: incoming.method, headers, signal }, (response) => {
      responseArrived = true;
      remote.setTimeout(0);
      outgoing.statusCode = response.statusCode ?? 502;
      for (const [name, value] of forwardedResponseHeaders(response.headers))
        outgoing.setHeader(name, value);
      outgoing.flushHeaders();
      pipeline(response, outgoing, { signal }).then(resolve, reject);
    });
    remote.setTimeout(30_000, () =>
      remote.destroy(new Error("The remote service did not answer.")),
    );
    remote.once("error", reject);
    pipeline(incoming, bodyLimit(), remote, { signal }).catch((error: unknown) => {
      if (!responseArrived) reject(error);
    });
  });
}
