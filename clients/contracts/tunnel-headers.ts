import type { Capability } from "./connection.ts";
import { LocalRequestRefused } from "./model-error.ts";
import {
  decodeTunnelRequestHeaders,
  maximumUserAgentLength,
  mcpHeaderName,
  toolsOnlyHeader,
  tunnelRequestHeaderNames,
  tunnelResponseHeaderNames,
} from "./tunnel.ts";

/**
 * The request headers a local client's call carries upstream, on the device tunnel and the direct
 * forward alike. Tools calls add every `mcp-*` header; model calls keep the fixed set. A tools call
 * whose `mcp-*` headers break the tunnel's caps is refused, never trimmed: MCP 2026-07-28 routes a
 * request by those headers, so dropping one silently changes the call.
 *
 * `user-agent` travels only with routing headers. A server from before tools frames could carry
 * either refuses the whole frame, so a call that would work there without them must not gain one;
 * a call with routing headers fails there regardless. An oversized `user-agent` only describes the
 * client, so it is dropped rather than refused.
 */
export function forwardedRequestHeaders(
  incoming: Readonly<Record<string, string | readonly string[] | undefined>>,
  service: Capability,
): Record<string, string> {
  const headers: Record<string, string> = {};
  // The fixed names go first, in schema order, so a model call's frame stays byte-identical.
  const extras = Object.keys(incoming).filter(
    (name) => name.startsWith("mcp-") && !tunnelRequestHeaderNames.includes(name),
  );
  for (const name of [...tunnelRequestHeaderNames, ...extras]) {
    const value = incoming[name];
    if (typeof value !== "string" || (service === "models" && toolsOnlyHeader(name))) continue;
    headers[name] = value;
  }
  if (service === "models") return headers;
  if (extras.length === 0 || (headers["user-agent"]?.length ?? 0) > maximumUserAgentLength)
    delete headers["user-agent"];
  if (extras.some((name) => !mcpHeaderName.test(name)))
    throw new LocalRequestRefused(
      "The request has an MCP header name the connection cannot carry.",
    );
  try {
    decodeTunnelRequestHeaders(headers);
  } catch {
    throw new LocalRequestRefused(
      "The request's MCP headers exceed what the connection can carry.",
    );
  }
  return headers;
}

/**
 * A response the direct forward relays to a local client. It is not a tunnel frame, but follows
 * the frame schema's names: the fixed set plus MCP's own, which a 2026-07-28 tools service may
 * answer with. Node itself refuses values with control characters.
 */
export const relayedResponseHeader = (name: string) =>
  tunnelResponseHeaderNames.includes(name) || mcpHeaderName.test(name);
