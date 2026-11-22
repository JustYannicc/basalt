import { DurableObject } from "cloudflare:workers";
import { relayHomePeer } from "../pool/home-peer-relay.ts";
import { RouteRefused, type GatewayContainer } from "./control.ts";
import { RouteGatewayCore } from "./gateway.ts";
import { emitRouteReadingChanged, type ReasonCode } from "./reading.ts";
import { handleRouteAcquisition, type RouteGatewayRpc } from "./acquisitions.ts";

export interface RouteEnvironment {
  /** Absent until the class is declared (ROUTE_GATEWAY_CLASS); every route then reads unavailable. */
  RouteGateway?: DurableObjectNamespace<RouteGateway>;
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
}

const tunnelPath = "/_internal/route/tunnel";
const ownerHeader = "X-Signalbox-Route-Owner";

/**
 * A DO cannot return a WebSocket over RPC (workerd refuses to serialize it), so the tunnel rides a
 * private stub fetch like the Home peer's. Only PoolRoutePeer builds it, from its own trusted props;
 * the public Worker never forwards to this class.
 */
export function routeTunnelUpgrade(caller: { owner: string }) {
  return new Request(`http://route-gateway.internal${tunnelPath}`, {
    headers: { Upgrade: "websocket", [ownerHeader]: caller.owner },
  });
}

/** Tunnel refusals are close codes on an accepted socket, so the pool sees one reason code. */
export function refusedTunnel(reason: ReasonCode) {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(reason === "route_not_permitted" ? 1008 : 1013, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** The route-acquisition receiver, served by PoolWorker without waking the pool. */
export function routeAcquisition(request: Request, env: RouteEnvironment) {
  return handleRouteAcquisition(request, {
    signingKey: env.POOL_APP_SIGNING_KEY,
    previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
    gateway: (routeId) => {
      const gateways = env.RouteGateway?.jurisdiction("eu");
      return gateways?.get(gateways.idFromName(routeId)) as RouteGatewayRpc | undefined;
    },
    now: Date.now,
  });
}

/** One gateway container per route account; `idFromName(routeId)` keeps its identity single. */
export class RouteGateway extends DurableObject<RouteEnvironment> {
  private core: RouteGatewayCore;
  constructor(ctx: DurableObjectState, env: RouteEnvironment) {
    super(ctx, env);
    this.core = new RouteGatewayCore({
      storage: ctx.storage,
      container: ctx.container as GatewayContainer | undefined,
      name: ctx.id.name,
      secret: env.POOL_APP_SIGNING_KEY,
      previousSecret: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      emit: emitRouteReadingChanged,
    });
  }
  create(input: unknown) {
    return this.core.create(input);
  }
  login(input: unknown) {
    return this.core.login(input);
  }
  joinStatus(input: unknown) {
    return this.core.joinStatus(input);
  }
  exits(input: unknown) {
    return this.core.exits(input);
  }
  select(caller: unknown, input: unknown) {
    return this.core.select(caller, input);
  }
  reading(input: unknown) {
    return this.core.reading(input);
  }
  disconnect(input: unknown) {
    return this.core.disconnect(input);
  }
  override async alarm() {
    await this.core.alarm();
  }
  /** Slice 1 serves only the private tunnel upgrade; slice 2 adds tool traffic here. */
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname !== tunnelPath) return new Response(null, { status: 501 });
    const owner = request.headers.get(ownerHeader);
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      url.search ||
      !owner
    )
      return new Response(null, { status: 501 });
    let socket;
    try {
      socket = await this.core.openTunnel({ owner });
    } catch (error) {
      return refusedTunnel(
        error instanceof RouteRefused ? error.reason : "route_gateway_unavailable",
      );
    }
    const pair = new WebSocketPair();
    pair[1].accept();
    relayHomePeer(socket, pair[1], (work) => this.ctx.waitUntil(work));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
