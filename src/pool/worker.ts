import { DurableObject } from "cloudflare:workers";
import { isControlPath } from "../../apps/pool/contract.ts";
import { PoolControl } from "./attribution.ts";
import { isPublicModelPath, PoolLifecycle, poolPort } from "./lifecycle.ts";

export interface PoolEnvironment {
  PoolContainer: DurableObjectNamespace;
  POOL_DATABASE_URL: string;
  POOL_MANAGEMENT_KEY: string;
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  POOL_IMAGE_HASH: string;
}

export class PoolContainer extends DurableObject<PoolEnvironment> {
  private lifecycle: Promise<PoolLifecycle>;
  private control: PoolControl;
  private managementReadyUntil = 0;
  private managementWarming?: Promise<void>;

  constructor(ctx: DurableObjectState, env: PoolEnvironment) {
    super(ctx, env);
    this.lifecycle = this.createLifecycle(ctx, env);
    this.control = new PoolControl(ctx.storage, {
      signingKey: env.POOL_APP_SIGNING_KEY,
      previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS,
      defer: (work) => ctx.waitUntil(work),
      home: async (path, init) => {
        if (!env.POOL_MANAGEMENT_KEY) throw new Error("Pool management key is missing");
        await this.managementReady();
        const container = this.ctx.container;
        if (!container) throw new Error("Pool container unavailable");
        const headers = new Headers(init?.headers);
        headers.set("X-Management-Key", env.POOL_MANAGEMENT_KEY);
        return container.getTcpPort(8327).fetch(new Request(`http://pool${path}`, { ...init, headers }));
      },
    });
  }

  private async managementReady(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running && Date.now() < this.managementReadyUntil) return;
    if (!this.managementWarming) {
      this.managementWarming = (async () => {
        await (await this.lifecycle).warm();
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
    await (await this.lifecycle).warm();
    await this.control.expire();
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (isControlPath(pathname)) return this.control.handle(request);
    const port = poolPort(pathname);
    if (!port && pathname !== "/__warm") return new Response(null, { status: 404 });
    try {
      const status = await (await this.lifecycle).warm();
      if (pathname === "/__warm") return new Response(null, { status: 204 });
      const container = this.ctx.container;
      if (!container || !port) throw new Error("Pool container unavailable");
      const response = await container.getTcpPort(port).fetch(request);
      if (response.status === 101) return response;
      const headers = new Headers(response.headers);
      headers.set("X-Signalbox-Pool-Boot", status.boot_id);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return new Response(null, { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });
    }
  }
}

function singleton(env: PoolEnvironment) {
  // Jurisdiction constrains the DO itself. Container placement is configured separately.
  return env.PoolContainer.jurisdiction("eu").getByName("control-plane");
}

export default {
  fetch(request: Request, env: PoolEnvironment) {
    const pathname = new URL(request.url).pathname;
    // The control API checks its own pool token; everything else public is the model gateway.
    if (!isControlPath(pathname) && !isPublicModelPath(pathname)) {
      return new Response(null, { status: 404 });
    }
    return singleton(env).fetch(request);
  },
  async scheduled(_event: ScheduledEvent, env: PoolEnvironment) {
    const response = await singleton(env).fetch("http://pool/__warm");
    if (!response.ok) throw new Error("Pool prewarming failed");
  },
};
