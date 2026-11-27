import { WorkerEntrypoint } from "cloudflare:workers";
import { routeIdPattern } from "./access.ts";
import { refusedTunnel, routeTunnelUpgrade, type RouteEnvironment } from "./gateway.worker.ts";
import type { ReasonCode } from "./reading.ts";

/**
 * One line per refusal, by reason code only, never a route, owner or pool. Until the route
 * gateway's class is declared no credential is routed, so production expects none.
 */
function refuse(reason: ReasonCode | "route_request_invalid") {
  console.error("POOL_ROUTE_TUNNEL_REFUSED", JSON.stringify({ reason }));
  return reason === "route_request_invalid"
    ? new Response(null, { status: 403 })
    : refusedTunnel(reason);
}

/** The pool controller owns which routes its credentials use, and on whose behalf. */
export interface RouteOwnerSource {
  routeOwner(input: { routeId: string }): Promise<string | null>;
}
export interface PoolRoutePeerEnvironment extends RouteEnvironment {
  PoolContainer: DurableObjectNamespace;
}

/**
 * Mirrors PoolHomePeer: only a container-bound loopback supplies `pool`, and no request header
 * selects it. A route id reaches a gateway only when this pool itself assigned it to a credential.
 */
export class PoolRoutePeer extends WorkerEntrypoint<PoolRoutePeerEnvironment, { pool: string }> {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const match = /^\/route\/([^/]+)$/u.exec(url.pathname);
    const routeId = match?.[1];
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      url.hostname !== "route-peer.internal" ||
      url.search ||
      !routeId ||
      !routeIdPattern.test(routeId) ||
      !this.ctx.props.pool
    )
      return refuse("route_request_invalid");
    let owner: string | null;
    try {
      const pools = this.env.PoolContainer.jurisdiction("eu");
      const controller = pools.get(pools.idFromString(this.ctx.props.pool));
      owner = await (controller as unknown as RouteOwnerSource).routeOwner({ routeId });
    } catch {
      return refuse("route_gateway_unavailable");
    }
    if (typeof owner !== "string" || !owner) return refuse("route_not_permitted");
    const gateways = this.env.RouteGateway?.jurisdiction("eu");
    if (!gateways) return refuse("route_gateway_unavailable");
    try {
      return await gateways.get(gateways.idFromName(routeId)).fetch(routeTunnelUpgrade({ owner }));
    } catch {
      return refuse("route_gateway_unavailable");
    }
  }
}
