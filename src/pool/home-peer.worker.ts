import { WorkerEntrypoint } from "cloudflare:workers";
import { HomePeerAccess, HomePeerSource, peerTarget } from "./runtime-slots/peer-access.ts";
import {
  SlotRefused,
  sameTarget,
  type SlotIdentity,
  type SlotTarget,
} from "./runtime-slots/contract.ts";
import type { PoolEnvironment } from "./worker.ts";
import { relayHomePeer } from "./home-peer-relay.ts";
import { homePeerUpgrade } from "./home-peer-transport.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

/** Only a container-bound loopback supplies the source; no request header selects its identity. */
export class PoolHomePeer extends WorkerEntrypoint<PoolEnvironment, { source: HomePeerSource }> {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const match = /^\/peer\/(0|[1-9][0-9]{0,2})$/.exec(url.pathname);
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      url.hostname !== "home-peer.internal" ||
      url.search ||
      !match ||
      Number(match[1]) > 128
    )
      return new Response(null, { status: 403 });
    const source = this.ctx.props.source;
    const namespace = this.env.PoolContainer.jurisdiction("eu");
    return namespace
      .get(namespace.idFromString(peerTarget(source).controllerId))
      .fetch(homePeerUpgrade(source, Number(match[1])));
  }
}

/** This transport never warms a Home. Its TCP bytes retain the Homes' own mutual TLS. */
export class RuntimeHomePeerTransport {
  private ctx: DurableObjectState;
  private gate: HomePeerAccess;
  constructor(
    ctx: DurableObjectState,
    key: string,
    health: (identity: SlotIdentity) => Promise<unknown>,
  ) {
    this.ctx = ctx;
    this.gate = new HomePeerAccess(ctx, key, health);
  }
  private async install(source: HomePeerSource) {
    if (!this.ctx.container) throw new SlotRefused("uncertain");
    await this.ctx.container.interceptOutboundHttp(
      "home-peer.internal",
      this.ctx.exports.PoolHomePeer({ props: { source } }),
    );
  }
  async configure(source: HomePeerSource) {
    await this.gate.retain(source);
    await this.install(source);
  }
  async restore() {
    const source = await this.gate.retained();
    if (source) await this.install(source);
  }
  async source(target: SlotTarget) {
    const source = await this.gate.current();
    if (!source || !sameTarget(peerTarget(source), target)) throw new SlotRefused("identity");
    return source;
  }
  assert(source: HomePeerSource) {
    return this.gate.assert(source);
  }
  async open(source: HomePeerSource) {
    await this.gate.assert(source);
    const socket = this.ctx
      .container!.getTcpPort(peerTarget(source).homePeerOrdinal === undefined ? 8327 : 8329)
      .connect("127.0.0.1:8329", { allowHalfOpen: true });
    await socket.opened;
    try {
      // Recheck after connecting so a concurrent retirement cannot expose a stale target.
      await this.gate.assert(source);
      const pair = new WebSocketPair();
      pair[1].accept();
      relayHomePeer(socket, pair[1], (work) => this.ctx.waitUntil(work));
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch (error) {
      await socket.close().catch(() => {});
      throw error;
    }
  }
}
