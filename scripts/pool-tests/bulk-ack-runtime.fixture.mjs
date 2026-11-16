import { DurableObject } from "cloudflare:workers";
import { BulkCoordinator, bulkObjectName } from "../../src/pool/model-history/bulk-coordinator.ts";
import { BulkJob } from "../../src/pool/model-history/bulk-job.ts";
import { ChunkStorage } from "../../src/pool/usage-storage.ts";
import { routeBulkImport } from "../../src/pool/model-history/bulk-http.ts";

export class StagingFixture extends DurableObject {
  uploading = false;
  constructor(ctx, env) {
    super(ctx, env);
    const gate = (phase) => env.GATES.fetch(`http://fixture/${phase}`);
    const storage = new Proxy(ctx.storage, {
      get: (target, key) => {
        if (key === "transaction")
          return async (work) => {
            const value = await target.transaction(async (tx) => {
              const result = await work(tx);
              if (this.uploading) await gate("save-entered");
              return result;
            });
            if (this.uploading) await gate("save-committed");
            return value;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.storage = storage;
    this.coordinator = new BulkCoordinator(
      { storage, setAlarm: (at) => ctx.storage.setAlarm(at) },
      {
        ...env,
        UsageImportArtifacts: {
          get: (key) => env.UsageImportArtifacts.get(key),
          put: async (key, data) => {
            await gate("put-entered");
            await env.UsageImportArtifacts.put(key, data);
            await gate("put-committed");
          },
        },
      },
      (job) => ctx.id.name === bulkObjectName(job),
    );
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/__fixture/prepare") {
      const definition = await request.json();
      const chunks = new ChunkStorage(this.storage);
      const job = new BulkJob({
        storage: {
          get: (key) => chunks.get(key),
          put: (key, value) =>
            chunks.commit(
              new Map([
                [key, value],
                ["bulk-usage-import-object-v1", definition.job],
              ]),
              [],
              "bulk-state-publication",
            ),
        },
        setAlarm: async () => {},
        artifacts: { get: async () => null, put: async () => {} },
        validateChunk: async () => {},
        commitChunk: async () => {
          throw new Error("Fixture cannot import SQL");
        },
        admit: async () => {},
        now: Date.now,
      });
      return Response.json(await job.begin(definition));
    }
    const body = await request.clone().json();
    const encoded = body.envelope.split(".")[1];
    const payload = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
    this.uploading = payload.input.operation === "upload";
    try {
      return await this.coordinator.handle(request);
    } finally {
      this.uploading = false;
    }
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/prepare")
      return env.Jobs.getByName(bulkObjectName(url.searchParams.get("job"))).fetch(request);
    return routeBulkImport(request, {
      signingKey: env.POOL_APP_SIGNING_KEY,
      jobs: { jurisdiction: () => env.Jobs },
    });
  },
};
