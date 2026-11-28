import { Option, Schema } from "effect";
import { SlotSelection } from "./runtime-slots/contract.ts";

interface RoutePeerHost {
  readonly exports?: object;
  readonly container?: { interceptOutboundHttp(host: string, target: never): Promise<void> };
}
type RoutePeerExport = (options: { props: { pool: string } }) => never;

/**
 * How long a start waits for the route intercept. Past it the start goes on without the intercept,
 * as when installing it throws: unrouted credentials are served, routed ones refused (#2221).
 */
export const routePeerInstallMs = 5_000;

/**
 * The one hook between a pool container and its routes: route_peer.py's tunnels reach
 * `route-peer.internal`, and PoolRoutePeer asks the controller `pool` who owns each route. The
 * props come only from this binding. Until PoolRoutePeer is exported nothing is intercepted, so
 * a routed credential's tunnel cannot open and route_peer.py refuses it: blocked, never direct.
 * POOL_ROUTE_PEER_INTERCEPT_PENDING is not retried here. The intercept still lands if the late
 * call succeeds, and it is installed again at the object's next start or legacy bootstrap
 * (`configure`), its next isolate (`restore`), and every controller construction.
 */
export async function installRoutePeer(
  ctx: RoutePeerHost,
  pool: string,
  boundMs = routePeerInstallMs,
) {
  const exports: unknown = ctx.exports;
  const peer: unknown =
    exports && typeof exports === "object" ? Reflect.get(exports, "PoolRoutePeer") : undefined;
  if (typeof peer !== "function" || !ctx.container) return;
  let installed: Promise<boolean>;
  try {
    // Settled here, so an answer after the bound, success or failure, is never an unhandled rejection.
    installed = ctx.container
      .interceptOutboundHttp("route-peer.internal", (peer as RoutePeerExport)({ props: { pool } }))
      .then(
        () => true,
        () => false,
      );
  } catch {
    installed = Promise.resolve(false);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), boundMs);
  });
  // Never fails the home-peer install beside it: without the intercept, tunnels are refused.
  if (!(await Promise.race([installed, bound]))) console.error("POOL_ROUTE_PEER_INTERCEPT_PENDING");
  clearTimeout(timer);
}

/**
 * The one image every runtime a sign-in's management calls can reach runs, or null when they don't
 * agree. With a slot selection, each call goes to the selection's active runtime
 * (runtime-slots/integration.ts `selected()`), so the reachable set across a handoff is its active,
 * candidate and draining records; the root container and unselected colours are never reached.
 * Without one, only the root container takes them. An unreadable selection is never agreement.
 */
export function servingImage(rootImage: string, selection: unknown): string | null {
  if (selection === undefined) return rootImage || null;
  const read = Schema.decodeUnknownOption(SlotSelection)(selection);
  if (Option.isNone(read)) return null;
  const decoded = read.value;
  const image = decoded.active.target.imageInput;
  return [decoded.candidate, decoded.draining].every(
    (record) => record === undefined || record.target.imageInput === image,
  )
    ? image
    : null;
}
