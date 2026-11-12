import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { DurableObject } from "cloudflare:workers";
import { RuntimeEndpoint, type EndpointEnvironment } from "./runtime-slots/endpoint.ts";
import { runtimeRequest } from "./runtime-slots/transport.ts";
import { nativeResponse } from "./native-response.worker.ts";
import { RuntimeHomePeerTransport } from "./home-peer.worker.ts";
import type { HomePeerSource } from "./runtime-slots/peer-access.ts";
import type { SlotTarget } from "./runtime-slots/contract.ts";

/** Code only. The admitted release path must separately create and bind this class. */
export class PoolRuntime extends DurableObject<EndpointEnvironment> {
  private endpoint: RuntimeEndpoint;
  private peers: RuntimeHomePeerTransport;
  constructor(ctx: DurableObjectState, env: EndpointEnvironment) {
    super(ctx, env);
    this.peers = new RuntimeHomePeerTransport(ctx, env.POOL_DEPLOYMENT_KEY ?? "", (identity) =>
      this.endpoint.health(identity, AbortSignal.timeout(2_000)),
    );
    this.endpoint = new RuntimeEndpoint(
      ctx,
      env,
      "runtime",
      {
        candidate: productionOpsRelease,
        workerInput: poolWorkerRevision,
      },
      nativeResponse,
      { beforeStart: (witness) => this.peers.configure({ kind: "runtime", witness }) },
    );
    ctx.waitUntil(this.peers.restore().catch(() => {}));
  }
  fetch(request: Request) {
    return runtimeRequest(request, this.endpoint);
  }
  homePeerSource(target: SlotTarget) {
    return this.peers.source(target);
  }
  assertHomePeer(source: HomePeerSource) {
    return this.peers.assert(source);
  }
  openHomePeer(source: HomePeerSource) {
    return this.peers.open(source);
  }
}

interface FleetRuntimeEnvironment extends EndpointEnvironment {
  POOL_BLUE_APPLICATION_ID?: string;
  POOL_BLUE_IMAGE_HASH?: string;
  POOL_GREEN_APPLICATION_ID?: string;
  POOL_GREEN_IMAGE_HASH?: string;
}
export class PoolRuntimeBlue extends PoolRuntime {
  constructor(ctx: DurableObjectState, env: FleetRuntimeEnvironment) {
    super(ctx, {
      ...env,
      POOL_RUNTIME_APPLICATION_ID: env.POOL_BLUE_APPLICATION_ID,
      POOL_IMAGE_HASH: env.POOL_BLUE_IMAGE_HASH ?? "",
    });
  }
}
export class PoolRuntimeGreen extends PoolRuntime {
  constructor(ctx: DurableObjectState, env: FleetRuntimeEnvironment) {
    super(ctx, {
      ...env,
      POOL_RUNTIME_APPLICATION_ID: env.POOL_GREEN_APPLICATION_ID,
      POOL_IMAGE_HASH: env.POOL_GREEN_IMAGE_HASH ?? "",
    });
  }
}
