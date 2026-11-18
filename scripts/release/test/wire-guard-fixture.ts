/**
 * A local Cloudflare/PlanetScale-shaped server for the wire guard tests. It records every request
 * that reaches it (method, path, byte count, metadata part) and answers with production-shaped
 * envelopes, so a refused request shows up as "nothing received".
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { Effect, Redacted } from "effect";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import type * as Workers from "@distilled.cloud/cloudflare/workers";

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly bytes: number;
  readonly metadata: unknown;
}

// The production container application read (prod shape 06b), values redacted.
export const applicationBody = (id: string) => ({
  id,
  created_at: "2026-11-18T00:00:00Z",
  updated_at: "2026-11-18T00:00:00Z",
  account_id: "synthetic-account",
  name: "synthetic-runtime",
  version: 1,
  scheduling_policy: "default",
  instances: 1,
  max_instances: 1,
  configuration: { image: "registry.invalid/runtime@sha256:00", vcpu: 0.25, memory_mib: 1024 },
  constraints: { regions: ["EEUR", "WEUR"], jurisdiction: "eu" },
  durable_objects: { namespace_id: "synthetic-namespace" },
});

const envelope = (result: unknown) =>
  JSON.stringify({ success: true, errors: [], messages: [], result });

export const startServer = async (createdId = "app-created-in-run") => {
  const received: Array<Received> = [];
  const server = createServer(async (request, response) => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let metadata: unknown;
    const type = request.headers["content-type"] ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      const part = form.get("metadata");
      metadata = typeof part === "string" ? JSON.parse(part) : undefined;
    }
    const path = request.url ?? "";
    received.push({ method: request.method ?? "", path, bytes: body.length, metadata });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && path.endsWith("/containers/applications"))
      return response.end(envelope(applicationBody(createdId)));
    if (request.method === "PUT" && /\/workers\/scripts\/[^/]+$/.test(path))
      return response.end(
        envelope({ id: "synthetic-pool-worker", etag: "etag", startup_time_ms: 10 }),
      );
    response.end(envelope(null));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server has no port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};

export const credentials = (base: string) =>
  Effect.provideService(
    Credentials,
    Effect.succeed({
      type: "apiToken" as const,
      apiToken: Redacted.make("synthetic"),
      apiBaseUrl: base,
    }),
  );

export const ACCOUNT = "1".repeat(32);
export const POOL_WORKER = "synthetic-pool-worker";

// PoolWorker's bindings as production's settings read returns them (prod shape 01), redacted.
const bindings: Workers.PutScriptRequest["metadata"]["bindings"] = [
  { type: "plain_text", name: "POOL_MODE", text: "synthetic" },
  { type: "durable_object_namespace", name: "POOL_CONTAINER", className: "PoolContainer" },
  { type: "durable_object_namespace", name: "POOL_RUNTIME_BLUE", className: "PoolRuntimeBlue" },
  { type: "durable_object_namespace", name: "POOL_RUNTIME_GREEN", className: "PoolRuntimeGreen" },
  {
    type: "durable_object_namespace",
    name: "BulkUsageImport",
    className: "ArtifactsTokenCoordinator",
    scriptName: "synthetic-other-worker",
  },
  { type: "secret_text", name: "POOL_SECRET", text: "synthetic" },
];

export const MAIN = "worker.js";
export const MAIN_SOURCE = "export class PoolContainer {}\nexport default {};\n";

/** A putScript request shaped like PoolWorker's upload, with the given migration step. */
export const poolWorkerUpload = (
  migrations?: Workers.PutScriptRequest["metadata"]["migrations"],
  source = MAIN_SOURCE,
): Workers.PutScriptRequest => ({
  accountId: ACCOUNT,
  scriptName: POOL_WORKER,
  metadata: {
    mainModule: MAIN,
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat", "new_module_registry"],
    usageModel: "standard",
    bindings,
    containers: [{ className: "PoolContainer" }],
    ...(migrations ? { migrations } : {}),
  },
  files: [new File([source], MAIN, { type: "application/javascript+module" })],
});
