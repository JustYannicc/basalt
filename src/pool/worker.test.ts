import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { signPoolToken } from "./token.ts";
import providers from "./providers.json" with { type: "json" };

// Node has no Workers runtime; keep the actual Worker and lifecycle with only the native base stubbed.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return {
      url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      shortCircuit: true,
    };
    return next(specifier, context);
  },
});
// Keep Workers-only declarations out of the Node typecheck, like the runtime stub above.
const workerModule = "./worker.ts";
const { PoolContainer }: {
  PoolContainer: new (ctx: object, env: object) => { fetch(request: Request): Promise<Response> };
} = await import(workerModule);
hooks.deregister();

test("management calls share readiness for 30 seconds and rewarm when the container stops", async (t) => {
  const signingKey = "ab".repeat(32);
  const token = await signPoolToken(signingKey, { pool: "fake-pool", owner: "fake-owner", organization: "fake-org" });
  const storage = new Map<string, unknown>();
  let alarm: number | null = null;
  let ready = 0;
  let starts = 0;
  let management = 0;
  const container = {
    running: true,
    destroy: async () => { container.running = false; },
    start: () => { starts++; container.running = true; },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (port === 8318) { ready++; return Response.json({ boot_id: "fake-boot", started_at: "2026-01-01T00:00:00Z" }); }
        assert.equal(port, 8327);
        const request = new Request(input, init);
        assert.equal(request.headers.get("X-Management-Key"), "obviously-fake-management-key");
        assert.notEqual(request.headers.get("Authorization"), `Bearer ${token}`);
        management++;
        const path = new URL(request.url).pathname;
        if (path.endsWith("/oauth/session")) return Response.json({ status: "ok", cancelled: true });
        if (path.endsWith("/credentials")) return Response.json({ files: [] });
        if (path.endsWith("/oauth/auth-url")) return Response.json({ state: `fake-state-${management}`, url: "https://login.example/start?redirect_uri=http%3A%2F%2Flocalhost%2Fend" });
        if (path.endsWith("/channel-groups")) return Response.json({ channel_groups: [] });
        throw new Error(`Unexpected management call ${path}`);
      } };
    },
  };
  const ctx = {
    container,
    waitUntil: () => {},
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); },
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => { alarm = time; },
    },
  };
  // Only the native runtime's constructor types are substituted in this Node test.
  const worker = new PoolContainer(ctx, {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "obviously-fake-management-key",
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_IMAGE_HASH: "fake-image",
  });
  async function start() {
    const response = await worker.fetch(new Request("https://pool.example/pool/v1/sign-ins", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "x-signalbox-caller": "fake-owner" },
      body: JSON.stringify({ provider: providers[0]!.id }),
    }));
    assert.equal(response.status, 200, await response.text());
  }
  t.mock.timers.enable({ apis: ["Date"] });
  await start();
  assert.equal(management, 2);
  assert.equal(ready, 1);
  await start(); assert.equal(ready, 1);
  t.mock.timers.tick(30_001);
  await start(); assert.equal(ready, 2);
  container.running = false;
  await start(); assert.equal(ready, 3);
  assert.equal(starts, 2);
});
