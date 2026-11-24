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
 * Whether every runtime that can take a sign-in's management calls runs one image input: the root
 * container, the bound blue and green cell applications, and every runtime the slot selection names
 * (active, candidate, draining). Unbound applications are absent and don't count.
 */
export function servesOneImage(images: readonly (string | undefined)[], selection: unknown) {
  const bound = images.filter((image): image is string => Boolean(image));
  const root = bound[0];
  if (root === undefined || bound.some((image) => image !== root)) return false;
  if (selection === undefined) return true;
  let decoded: SlotSelection;
  try {
    decoded = Schema.decodeUnknownSync(SlotSelection)(selection);
  } catch {
    return false;
  }
  return [decoded.active, decoded.candidate, decoded.draining].every(
    (record) => record === undefined || record.target.imageInput === root,
  );
}
