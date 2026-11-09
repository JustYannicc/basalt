import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { DurableObject } from "cloudflare:workers";
import { RuntimeEndpoint, type EndpointEnvironment } from "./runtime-slots/endpoint.ts";
import { runtimeRequest } from "./runtime-slots/transport.ts";

/** Code only. The admitted release path must separately create and bind this class. */
export class PoolRuntime extends DurableObject<EndpointEnvironment> {
  private endpoint: RuntimeEndpoint;
  constructor(ctx: DurableObjectState, env: EndpointEnvironment) {
    super(ctx, env);
    this.endpoint = new RuntimeEndpoint(ctx, env, "runtime", {
      candidate: productionOpsRelease,
      workerInput: poolWorkerRevision,
    });
  }
  fetch(request: Request) {
    return runtimeRequest(request, this.endpoint);
  }
}
