import { Schema } from "effect";
import { SlotSelection } from "./runtime-slots/contract.ts";

interface RoutePeerHost {
  readonly exports?: object;
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
  const exports: unknown = ctx.exports;
  const peer: unknown =
    exports && typeof exports === "object" ? Reflect.get(exports, "PoolRoutePeer") : undefined;
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

/**
 * Whether every runtime a sign-in's management calls can reach runs one image input. With a slot
 * selection, each call goes to the selection's active runtime (runtime-slots/integration.ts
 * `selected()`), so the reachable set across a handoff is its active, candidate and draining
 * records; the root container and unselected colours are never reached. Without one, only the root
 * container takes them, which is one image by itself. An unreadable selection is never agreement.
 */
export function servesOneImage(selection: unknown) {
  if (selection === undefined) return true;
  let decoded: SlotSelection;
  try {
    decoded = Schema.decodeUnknownSync(SlotSelection)(selection);
  } catch {
    return false;
  }
  const image = decoded.active.target.imageInput;
  return [decoded.candidate, decoded.draining].every(
    (record) => record === undefined || record.target.imageInput === image,
  );
}
