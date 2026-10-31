import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { captureProduct, type ProductEvent, type TelemetryEnv } from "../telemetry/product.ts";
import type { ProductEventCallback } from "../setup/product-events.ts";
import { isControlPath } from "../../apps/pool/contract.ts";
import { PoolControl } from "./attribution.ts";
import { HomeClient } from "./control.ts";
import { ComputerHome } from "./computer-home.ts";
import { Computers } from "./computers.ts";
import { accessPath } from "./access-contract.ts";
import { requirePoolUse } from "./authorization.ts";
import { ControlFailure, failureResponse } from "./json.ts";
import { isPublicModelPath, PoolLifecycle, poolLifecycle, poolPort } from "./lifecycle.ts";
import { modelPaths, rewriteCapResponse } from "./cap-message.ts";
import { containerRequest } from "./container-request.ts";
import { nativeControlPath, nativeModelHeader } from "./native-contract.ts";
import { nativeResponse } from "./native-response.worker.ts";
import {
  hasActiveHomeApiKey,
  homeApiKeyCandidates,
  type HomeApiKeyLookup,
} from "./model-auth.ts";
import { PriceUpkeep } from "./prices.ts";
import { PoolUsage, summaryPath } from "./pool-usage.ts";
import { timePoolRead } from "./read-timing.ts";
import { inventoryCron, reportPoolInventory } from "./inventory.ts";
import { reportPoolStorage } from "./inventory-storage.ts";
import { migrateCodexWebSockets, type CodexWebSocketPlan } from "./codex-websockets.ts";
import { captureHomeRequests } from "./model-history/capture.ts";
import { withHistoryDatabase } from "./model-history/database.ts";
import { handleModelHistory, modelHistoryPath } from "./model-history/http.ts";
import { handleModelHistoryOperation, historyBackfillPath, historySchemaApplyPath, historySchemaCatalogPath } from "./model-history/operator.ts";
import { handleUsageImport, modelImportPath } from "./model-history/import-http.ts";


export interface PoolEnvironment extends TelemetryEnv {
  PoolContainer: DurableObjectNamespace<PoolContainer>;
  POOL_DATABASE_URL: string;
  POOL_AUTH_DATABASE?: Hyperdrive;
  POOL_MANAGEMENT_KEY: string;
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  POOL_IMAGE_HASH: string;
  POOL_MODEL_HISTORY_ENABLED?: string;
}

export class PoolContainer extends DurableObject<PoolEnvironment> {
  private lifecycle: Promise<PoolLifecycle>;
  private control: PoolControl;
  private computers: Computers;
  private prices: PriceUpkeep;
  private usage: PoolUsage;
  private managementReadyUntil = 0;
  private managementWarming?: Promise<void>;

  constructor(ctx: DurableObjectState, env: PoolEnvironment) {
    super(ctx, env);
    // A restarted object, after a deploy or an eviction, has lost its container's inactivity
    // timeout, and the platform stops a running container soon after the object goes idle.
    // Requests that never warm the pool, like an hourly inventory or setup polling, did exactly that.
    if (ctx.container?.running) ctx.waitUntil(ctx.container.setInactivityTimeout(poolLifecycle.idleTimeoutMs));
    this.lifecycle = this.createLifecycle(ctx, env);
    const onProductEvent: ProductEventCallback = (event: ProductEvent, accountId: string) => {
      ctx.waitUntil(captureProduct(env, event, accountId));
    };
    const home = async (path: string, init?: RequestInit) => {
        if (!env.POOL_MANAGEMENT_KEY) throw new Error("Pool management key is missing");
        init?.signal?.throwIfAborted();
        await this.managementReady();
        init?.signal?.throwIfAborted();
        const container = this.ctx.container;
        if (!container) throw new Error("Pool container unavailable");
        const headers = new Headers(init?.headers);
        headers.set("X-Management-Key", env.POOL_MANAGEMENT_KEY);
        return container.getTcpPort(8327).fetch(new Request(`http://pool${path}`, { ...init, headers }));
      };
    this.control = new PoolControl(ctx.storage, {
      signingKey: env.POOL_APP_SIGNING_KEY,
      previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      audience: (pool) => this.computers.audience(pool),
      defer: (work) => ctx.waitUntil(work), home, onProductEvent,
    });
    this.prices = new PriceUpkeep(new HomeClient(home), ctx.storage);
    this.usage = new PoolUsage({
      storage: ctx.storage, client: new HomeClient(home),
      signingKey: env.POOL_APP_SIGNING_KEY, previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      audience: (pool) => this.computers.audience(pool), defer: (work) => ctx.waitUntil(work),
      collection: this.control.collection,
      permissions: (pool, user) => this.computers.permissions(pool, user),
    });
    this.computers = new Computers({
      storage: ctx.storage, home: new ComputerHome(new HomeClient(home), onProductEvent),
      signingKey: env.POOL_APP_SIGNING_KEY, previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      onProductEvent, usage: this.usage,
    });
  }

  private async managementReady(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running && Date.now() < this.managementReadyUntil) return;
    if (!this.managementWarming) {
      this.managementWarming = (async () => {
        await timePoolRead("readiness", async () => (await this.lifecycle).warm());
        this.managementReadyUntil = Date.now() + 30_000;
      })().finally(() => { this.managementWarming = undefined; });
    }
    return this.managementWarming;
  }

  private async createLifecycle(ctx: DurableObjectState, env: PoolEnvironment) {
    const container = ctx.container;
    if (!container) throw new Error("Pool container binding is missing");
    if (!env.POOL_DATABASE_URL || !env.POOL_MANAGEMENT_KEY || !env.POOL_IMAGE_HASH) {
      throw new Error("Pool deployment secrets or image revision are missing");
    }
    const input = new TextEncoder().encode(JSON.stringify([
      env.POOL_DATABASE_URL, env.POOL_MANAGEMENT_KEY, env.POOL_IMAGE_HASH,
    ]));
    const revision = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return new PoolLifecycle({
      running: () => container.running,
      start: () => container.start({
        enableInternet: true,
        env: {
          POOL_DATABASE_URL: env.POOL_DATABASE_URL,
          POOL_MANAGEMENT_KEY: env.POOL_MANAGEMENT_KEY,
          POOL_MANAGEMENT_ALLOW_REMOTE: "true",
        },
      }),
      stop: () => container.destroy(),
      keepAlive: (duration) => container.setInactivityTimeout(duration),
      status: async () => {
        const response = await container.getTcpPort(8318).fetch("http://pool/ready", {
          signal: AbortSignal.timeout(2_000),
          headers: { Authorization: `Bearer ${env.POOL_MANAGEMENT_KEY}` },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("The pool is not ready");
        }
        const status = await response.json<{ boot_id: string; started_at: string }>();
        if (typeof status.boot_id !== "string" || typeof status.started_at !== "string") {
          throw new Error("Invalid pool readiness response");
        }
        return status;
      },
    }, ctx.storage, revision);
  }

  async alarm() {
    await this.computers.expire();
    await (await this.lifecycle).warm();
    await this.computers.observeUsage();
    await this.control.expire();
    await this.prices.run();
    // Usage is a report: a slow or failing read must not hold the pool's own upkeep.
    await this.usage.observe().catch((error: unknown) => console.error("Pool usage observation failed", error));
    if (this.env.POOL_MODEL_HISTORY_ENABLED === "true") {
      try { await withHistoryDatabase(this.env.POOL_AUTH_DATABASE?.connectionString, captureHomeRequests); }
      catch { console.error("POOL_MODEL_HISTORY_FAILURE count=1"); }
    }
  }

  async migrationInventory(): Promise<void> {
    await reportPoolStorage(this.ctx.storage);
  }

  async migrateCodexWebSockets(approved?: Pick<CodexWebSocketPlan, "digest" | "pending">) {
    await this.managementReady();
    const container = this.ctx.container;
    if (!container) throw new Error("Pool container unavailable");
    const client = new HomeClient((path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("X-Management-Key", this.env.POOL_MANAGEMENT_KEY);
      return container.getTcpPort(8327).fetch(new Request(`http://pool${path}`, { ...init, headers }));
    });
    return migrateCodexWebSockets(client, approved);
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === accessPath) return this.computers.access(request);
    if (pathname === nativeControlPath) return this.computers.nativeControl(request);
    if (isControlPath(pathname)) {
      try {
        await requirePoolUse(request, {
          signingKey: this.env.POOL_APP_SIGNING_KEY,
          previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
          permissions: (pool, user) => this.computers.permissions(pool, user),
        });
      } catch (error) { return failureResponse(error); }
    }
    if (pathname.startsWith("/__setup/v1/")) return this.computers.handle(request);
    if (pathname === "/pool/v1/computers" || pathname === "/pool/v1/setup-context") {
      const response = await this.computers.context(request);
      // Connect reads this when it opens; copying a setup prompt next mints a key in Home, so start
      // a cold pool now rather than on that click. Only an authorized read may start the shared
      // container. A failed warm is retried by the next Home call.
      if (response.ok) this.ctx.waitUntil(this.managementReady().catch(() => {}));
      return response;
    }
    if (pathname === summaryPath) return this.usage.handle(request);
    if (pathname === modelHistoryPath || pathname === modelImportPath) return (pathname === modelHistoryPath ? handleModelHistory : handleUsageImport)(request, {
      signingKey: this.env.POOL_APP_SIGNING_KEY, previousSigningKey: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
      connectionString: this.env.POOL_AUTH_DATABASE?.connectionString,
      permissions: (pool, caller) => this.computers.permissions(pool, caller),
    });
    if (isControlPath(pathname)) return this.control.handle(request);
    const port = poolPort(pathname);
    if (!port && pathname !== "/__warm") return new Response(null, { status: 404 });
    let native: Awaited<ReturnType<Computers["nativeModel"]>> | undefined;
    try {
      if (request.headers.has(nativeModelHeader)) {
        native = await this.computers.nativeModel(request);
        request = native.request;
      }
      const status = await (await this.lifecycle).warm();
      if (pathname === "/__warm") return new Response(null, { status: 204 });
      const container = this.ctx.container;
      if (!container || !port) throw new Error("Pool container unavailable");
      const upstream = await container.getTcpPort(port).fetch(containerRequest(request, "http://pool"));
      const response = await rewriteCapResponse(upstream, pathname);
      if (request.method === "POST" && modelPaths.has(pathname) && response.ok)
        this.ctx.waitUntil(this.computers.observeUsage());
      if (response.status === 101) return native === undefined ? response : nativeResponse(response, native);
      const headers = new Headers(response.headers);
      headers.set("X-Signalbox-Pool-Boot", status.boot_id);
      const forwarded = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      return native === undefined ? forwarded : nativeResponse(forwarded, native);
    } catch (error) {
      native?.release();
      if (error instanceof ControlFailure) return failureResponse(error);
      // Startup and port errors are fixed runtime messages without request data or credentials.
      console.error("Pool backend unavailable", error instanceof Error ? error.message.slice(0, 300) : "unknown error");
      return new Response(null, { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });
    }
  }
}

function singleton(env: PoolEnvironment) {
  // Jurisdiction constrains the DO itself. Container placement is configured separately.
  return env.PoolContainer.jurisdiction("eu").getByName("control-plane");
}

export async function handlePoolWorkerRequest(
  request: Request,
  env: PoolEnvironment,
  lookupHomeApiKey: HomeApiKeyLookup = hasActiveHomeApiKey,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === nativeControlPath) return singleton(env).fetch(request);
  if (pathname !== accessPath && !isControlPath(pathname) && !isPublicModelPath(pathname) && !pathname.startsWith("/__setup/v1/")) {
    return new Response(null, { status: 404 });
  }
  if (isPublicModelPath(pathname)) {
    if (request.headers.has(nativeModelHeader)) return singleton(env).fetch(request);
    const { supplied, values } = homeApiKeyCandidates(request);
    if (!supplied) return modelAuthResponse(401, "Missing API key");
    if (values.length === 0) return modelAuthResponse(401, "Invalid API key");
    try {
      const connectionString = env.POOL_AUTH_DATABASE?.connectionString;
      if (!connectionString) return modelAuthResponse(503, "Authentication service unavailable");
      if (!(await lookupHomeApiKey(connectionString, values)))
        return modelAuthResponse(401, "Invalid API key");
    } catch {
      return modelAuthResponse(503, "Authentication service unavailable");
    }
  }
  return singleton(env).fetch(request);
}

function modelAuthResponse(status: 401 | 503, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Only a service binding that explicitly selects this named entrypoint can invoke it. */
export class PoolOperations extends WorkerEntrypoint<PoolEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if ([historySchemaCatalogPath, historySchemaApplyPath, historyBackfillPath].includes(path))
      return handleModelHistoryOperation(request, this.env.POOL_DATABASE_URL);
    if (path !== "/codex-websockets") return new Response(null, { status: 404 });
    try {
      let approved: Pick<CodexWebSocketPlan, "digest" | "pending"> | undefined;
      if (request.method === "POST") {
        const value: unknown = await request.json();
        if (!value || typeof value !== "object" || !("digest" in value) || !("pending" in value)
          || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
          || typeof value.pending !== "number" || !Number.isSafeInteger(value.pending) || value.pending < 0)
          return new Response(null, { status: 400 });
        approved = { digest: value.digest, pending: value.pending };
      } else if (request.method !== "GET") return new Response(null, { status: 405 });
      return Response.json(await singleton(this.env).migrateCodexWebSockets(approved), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
}

export default {
  fetch(request: Request, env: PoolEnvironment) {
    return handlePoolWorkerRequest(request, env);
  },
  async scheduled(event: ScheduledEvent, env: PoolEnvironment) {
    if (event.cron === inventoryCron) {
      await reportPoolInventory(env.POOL_AUTH_DATABASE);
      await singleton(env).migrationInventory();
      return;
    }
    const response = await singleton(env).fetch("http://pool/__warm");
    if (!response.ok) throw new Error("Pool prewarming failed");
  },
};
