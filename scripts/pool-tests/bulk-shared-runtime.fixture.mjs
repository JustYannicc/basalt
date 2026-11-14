import { DurableObject } from "cloudflare:workers";
import { makeDurableObjectBridge } from "alchemy/Cloudflare/Bridge";
import entrypoint from "../../.upstream/apps/hosted/cloud/src/artifacts-credentials.ts";
import { ChunkStorage } from "../../src/pool/usage-storage.ts";
import { environmentObservation } from "./bulk-shared-env.fixture.mjs";

const SharedCoordinator = makeDurableObjectBridge(DurableObject, {
  entrypoint,
  stack: { name: "basalt", stage: "production" },
})("ArtifactsTokenCoordinator");

// Only test controls are added. All product fetch, RPC and alarm bodies come from the carried export.
export class ArtifactsTokenCoordinator extends SharedCoordinator {
  instance = crypto.randomUUID();
  async alarm() {}
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/__fixture/instance") return Response.json({ instance: this.instance });
    if (path === "/__fixture/evict") this.ctx.abort("shared coordinator fixture eviction");
    if (path === "/__fixture/prepare") {
      await this.ctx.storage.put("prepare", { repository: "code_fixture", trace: null });
      return new Response(null, { status: 204 });
    }
    if (path === "/__fixture/marker") {
      const { job } = await request.json();
      await new ChunkStorage(this.ctx.storage).put("bulk-usage-import-object-v1", job);
      return new Response(null, { status: 204 });
    }
    if (path === "/__fixture/storage")
      return Response.json({
        keys: [...(await this.ctx.storage.list()).keys()],
        hasPrepare: (await this.ctx.storage.get("prepare")) !== undefined,
      });
    if (path === "/__fixture/tick") {
      try {
        await super.alarm();
        return new Response(null, { status: 204 });
      } catch {
        return Response.json({ alarmRejected: true }, { status: 500 });
      }
    }
    return super.fetch(request);
  }
}

const rpcMethods = new Set([
  "acquire",
  "history",
  "resolve",
  "tree",
  "blobs",
  "file",
  "create",
  "vault",
]);
export default {
  async fetch(request, environment) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/env") return Response.json(environmentObservation());
    const job = url.searchParams.get("job");
    const name = url.searchParams.get("object") ?? `bulk-usage-import:${job}`;
    const stub = environment.ArtifactsTokenCoordinator.getByName(name);
    if (url.pathname === "/__fixture/rpc") {
      const { method, args } = await request.json();
      if (!rpcMethods.has(method)) throw new Error("Unknown fixture RPC");
      return Response.json(await stub[method](...args));
    }
    return stub.fetch(request);
  },
};
