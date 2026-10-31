import { tunnelProtocol } from "../../clients/contracts/tunnel.ts";
import { tunnelAccess, tunnelLease, type TunnelEnvironment } from "./access.ts";
import { tunnelPair, tunnelUpgrade } from "./platform.ts";
import { serveTunnel } from "./session.ts";

/** Only a native bearer may open this fixed-purpose outbound application channel. */
export async function handleTunnel(
  request: Request,
  env: TunnelEnvironment,
  context?: { waitUntil(work: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response(null, { status: 426 });
  if (
    url.search ||
    request.headers.has("origin") ||
    request.headers.get("sec-websocket-protocol") !== tunnelProtocol
  )
    return new Response(null, { status: 400 });
  try {
    const access = await tunnelAccess(request, env);
    if (access instanceof Response) return access;
    const lease = await tunnelLease(request, env, access);
    const pair = tunnelPair();
    serveTunnel(pair[1], lease, request, env, access, (work) => context?.waitUntil(work));
    return tunnelUpgrade(pair[0], tunnelProtocol);
  } catch {
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
