// The scratch stage's Worker: the real RouteGateway, PoolRoutePeer and acquisition receiver, plus a
// stand-in for the pool controller that assigns one scratch route to one scratch owner.
import { DurableObject } from "cloudflare:workers";
import {
  RouteGateway as Gateway,
  routeAcquisition,
  type RouteEnvironment,
} from "../../src/route/gateway.worker.ts";
import { PoolRoutePeer as Peer } from "../../src/route/pool-peer.worker.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { harnessPurpose, scratchOwner, scratchRoute } from "./identity.ts";

interface Env extends RouteEnvironment {
  RouteGateway?: DurableObjectNamespace<RouteGateway>;
  PoolContainer: DurableObjectNamespace<ScratchController>;
}
type Entry = (options: { props: { pool: string } }) => Fetcher;
interface Exports {
  PoolRoutePeer: Entry;
  BarePoolRoutePeer: Entry;
}

export class RouteGateway extends Gateway {
  /** The container dies under the object, as on a deploy or a crash. */
  async scratchKill() {
    await this.ctx.container?.destroy();
    return { killed: true };
  }
}

export class ScratchController extends DurableObject<Env> {
  async routeOwner({ routeId }: { routeId: string }) {
    return routeId === scratchRoute ? scratchOwner : null;
  }
}

export class PoolRoutePeer extends Peer {}

/** A pool whose Worker has no RouteGateway class: the peer must refuse with 1013. */
export class BarePoolRoutePeer extends Peer {
  constructor(ctx: ExecutionContext<{ pool: string }>, env: Env) {
    super(ctx, { ...env, RouteGateway: undefined });
  }
}

/** Every path but the receiver needs a fresh envelope signed with the run's own key. */
async function allowed(url: URL, env: Env) {
  const auth = url.searchParams.get("auth");
  const claims = auth && (await openEnvelope(env.POOL_APP_SIGNING_KEY, harnessPurpose, auth));
  return (
    !!claims &&
    typeof claims === "object" &&
    "expiresAt" in claims &&
    typeof claims.expiresAt === "number" &&
    claims.expiresAt > Date.now()
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/route/v1/acquisitions") return routeAcquisition(request, env);
    if (!(await allowed(url, env))) return new Response(null, { status: 404 });
    const pool = env.PoolContainer.jurisdiction("eu").idFromName("pool").toString();
    const peer = /^\/(peer|bare)\/([a-z0-9_]+)$/u.exec(url.pathname);
    if (peer) {
      const exports = ctx.exports as unknown as Exports;
      const entry = peer[1] === "bare" ? exports.BarePoolRoutePeer : exports.PoolRoutePeer;
      return entry({ props: { pool } }).fetch(
        new Request(`http://route-peer.internal/route/${peer[2]}`, { headers: request.headers }),
      );
    }
    if (url.pathname === "/kill") {
      const gateways = env.RouteGateway!.jurisdiction("eu");
      return Response.json(await gateways.get(gateways.idFromName(scratchRoute)).scratchKill());
    }
    return new Response(null, { status: 404 });
  },
};
