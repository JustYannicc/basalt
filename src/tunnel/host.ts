import { tunnelProtocol } from "../../clients/contracts/tunnel.ts";
import { tunnelAccess, tunnelLease, type TunnelEnvironment } from "./access.ts";
import { tunnelPair, tunnelUpgrade } from "./platform.ts";
import { serveTunnel } from "./session.ts";
import { sampleTunnelTiming } from "./timing.ts";

/** Only a native bearer may open this fixed-purpose outbound application channel. */
export async function handleTunnel(
  request: Request,
  env: TunnelEnvironment,
  context?: { waitUntil(work: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response(null, { status: 426 });
  // Native clients send no Origin (Node) or this server's own (React Native adds it and an app
  // can't remove it). Any other Origin, including "null", is a browser page elsewhere.
  const origin = request.headers.get("origin");
  if (
    url.search ||
    (origin !== null && origin !== url.origin) ||
    request.headers.get("sec-websocket-protocol") !== tunnelProtocol
  )
    return new Response(null, { status: 400 });
  const timing = sampleTunnelTiming();
  timing?.mark("start");
  try {
    const access = await tunnelAccess(request, env);
    timing?.mark("access");
    if (access instanceof Response) {
      timing?.mark("refused");
      return access;
    }
    const lease = await tunnelLease(request, env, access);
    timing?.mark("lease");
    const pair = tunnelPair();
    serveTunnel(pair[1], lease, request, env, access, (work) => context?.waitUntil(work), timing);
    return tunnelUpgrade(pair[0], tunnelProtocol);
  } catch {
    timing?.mark("failed");
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
