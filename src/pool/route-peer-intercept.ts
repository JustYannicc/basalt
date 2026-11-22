interface RoutePeerHost {
  readonly exports: object;
  readonly container?: { interceptOutboundHttp(host: string, target: never): Promise<void> };
}
type RoutePeerExport = (options: { props: { pool: string } }) => never;

/**
 * The one hook between a pool container and its routes: route_peer.py's tunnels reach
 * `route-peer.internal`, and PoolRoutePeer asks the controller `pool` who owns each route. The
 * props come only from this binding. Until PoolRoutePeer is exported nothing is intercepted, so
 * a routed credential's tunnel cannot open and route_peer.py refuses it: blocked, never direct.
 */
export async function installRoutePeer(ctx: RoutePeerHost, pool: string) {
  const peer: unknown = Reflect.get(ctx.exports, "PoolRoutePeer");
  if (typeof peer !== "function" || !ctx.container) return;
  try {
    await ctx.container.interceptOutboundHttp(
      "route-peer.internal",
      (peer as RoutePeerExport)({ props: { pool } }),
    );
  } catch {
    // Never fails the home-peer install beside it: without the intercept, tunnels are refused.
    console.error("POOL_ROUTE_PEER_INTERCEPT_PENDING");
  }
}
