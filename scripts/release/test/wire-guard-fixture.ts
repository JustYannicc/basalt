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
  readonly authorization: string | undefined;
}

// A container application read as production answers it (recorded 2026-11-18), values redacted.
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

const instances = (active: number) => ({
  active,
  assigned: 0,
  healthy: 0,
  stopped: 0,
  failed: 0,
  scheduling: 0,
  starting: 0,
});

/**
 * The application read as production returns it (recorded 2026-11-18, the legacy root and a new
 * application's read-back): the resolved configuration, the namespace attachment and the health
 * counters. `attached: false` is what Alchemy's precreate leaves: no `durable_objects` key.
 */
export const applicationRead = (input: { attached: boolean; active: number }) => ({
  success: true,
  result: {
    id: "synthetic-application",
    created_at: "2026-11-18T00:00:00Z",
    updated_at: "2026-11-18T00:00:00Z",
    account_id: "synthetic-account",
    name: "synthetic-runtime",
    version: input.attached ? 57 : 1,
    scheduling_policy: "default",
    instances: 1,
    max_instances: 1,
    configuration: {
      image: "registry.invalid/runtime@sha256:00",
      vcpu: 0.25,
      memory: "1GiB",
      memory_mib: 1024,
      disk: { size_mb: 4000, size: "4GB" },
      environment_variables: [{ name: "SYNTHETIC", value: "synthetic" }],
      network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
      command: [],
      entrypoint: [],
      runtime: "firecracker",
      observability: { logs: { enabled: true } },
    },
    constraints: { regions: ["EEUR", "WEUR"], jurisdiction: "eu" },
    ...(input.attached ? { durable_objects: { namespace_id: "synthetic-namespace" } } : {}),
    health: { errors: [], instances: instances(input.active) },
    network: { bandwidth_limit_mbps: 250 },
  },
  messages: [],
  errors: [],
});

const envelope = (result: unknown) =>
  JSON.stringify({ success: true, errors: [], messages: [], result });

export interface ServerOptions {
  readonly createdId?: string;
  /** The id a Worker version upload answers with. */
  readonly versionId?: string;
  /** GET answers for `/containers/applications/{id}`, by id; others answer 404. */
  readonly applications?: Readonly<Record<string, { status?: number; body: unknown }>>;
  /** When set, GET `/workers/scripts/{name}/settings` answers with these tags, by name; others 404. */
  readonly scriptTags?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const startServer = async ({
  createdId = "app-created-in-run",
  versionId = "synthetic-version",
  applications = {},
  scriptTags,
}: ServerOptions = {}) => {
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
    received.push({
      method: request.method ?? "",
      path,
      bytes: body.length,
      metadata,
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    const read = /\/containers\/applications\/([^/?]+)$/.exec(path)?.[1];
    if (request.method === "GET" && read !== undefined) {
      const answer = applications[read];
      response.statusCode = answer?.status ?? (answer ? 200 : 404);
      return response.end(
        JSON.stringify(
          answer?.body ?? { success: false, errors: [{ code: 1000 }], messages: [], result: null },
        ),
      );
    }
    const settings = /\/workers\/scripts\/([^/?]+)\/settings$/.exec(path)?.[1];
    if (request.method === "GET" && scriptTags && settings !== undefined) {
      const tags = scriptTags[decodeURIComponent(settings)];
      response.statusCode = tags ? 200 : 404;
      return response.end(
        tags
          ? envelope({ tags, bindings: [] })
          : JSON.stringify({
              success: false,
              errors: [{ code: 10007 }],
              messages: [],
              result: null,
            }),
      );
    }
    if (request.method === "POST" && path.endsWith("/containers/applications"))
      return response.end(envelope(applicationBody(createdId)));
    if (request.method === "POST" && /\/workers\/scripts\/[^/]+\/versions$/.test(path))
      return response.end(envelope({ id: versionId, number: 2, metadata: {} }));
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

// PoolWorker's bindings as production's settings read returns them (recorded 2026-11-18), redacted.
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
