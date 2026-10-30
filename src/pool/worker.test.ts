import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { signEnvelope, signPoolToken } from "./token.ts";
import { accessPath, accessPrefix, accessTtl } from "./access-contract.ts";
import providers from "./providers.json" with { type: "json" };

// Node has no Workers runtime; keep the actual Worker and lifecycle with platform adapters stubbed.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return {
      url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      shortCircuit: true,
    };
    if (specifier === "pg") return {
      url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query() { return { rows: [{ active: false }] }; } async end() {} } }",
      shortCircuit: true,
    };
    return next(specifier, context);
  },
});
// Keep Workers-only declarations out of the Node typecheck, like the runtime stub above.
const workerModule = "./worker.ts";
const { PoolContainer, default: poolWorker }: {
  PoolContainer: new (ctx: object, env: object) => { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };
  default: { fetch(request: Request, env: object): Promise<Response> };
} = await import(workerModule);
hooks.deregister();

test("the Durable Object alarm provisions pending pool members", async () => {
  const pool = { pool: "fake-pool", owner: "fake-owner", organization: "fake-org", name: "Pool",
    users: ["fake-owner", "fake-member"], pending: ["fake-member"], at: Date.now() };
  const values = new Map<string, unknown>([["pool-directory-v1", {
    pools: { [JSON.stringify(pool.pool)]: pool }, refusals: {}, people: {}, refusalsVersion: 2,
  }]]);
  const users: Record<string, unknown>[] = [];
  let alarm: number | null = null;
  const runtime = {
    running: false,
    destroy: async () => { runtime.running = false; },
    start: () => { runtime.running = true; },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (port === 8318) return Response.json({ boot_id: "fake-boot", started_at: "2026-01-01T00:00:00Z" });
        const request = new Request(input, init);
        assert.equal(new URL(request.url).pathname, "/v8/management/users");
        if (request.method === "POST") users.push({ ...await request.json() as object, id: 42 });
        return Response.json({ users });
      } };
    },
  };
  const worker = new PoolContainer({ container: runtime, waitUntil: () => {}, storage: {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => { alarm = time; },
  } }, {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "fake-management-key", POOL_APP_SIGNING_KEY: "ab".repeat(32), POOL_IMAGE_HASH: "fake-image",
  });
  await worker.alarm();
  assert.equal(users.length, 1);
  const state = values.get("pool-directory-v1") as { pools: Record<string, { pending: string[]; provisioned: string[] }> };
  assert.deepEqual(state.pools[JSON.stringify(pool.pool)]!.pending, []);
  assert.deepEqual(state.pools[JSON.stringify(pool.pool)]!.provisioned, ["fake-member"]);
  assert.ok(alarm);
});

test("signed access changes reach the computer queue before generic pool-token control routing", async () => {
  const signingKey = "ab".repeat(32);
  const values = new Map<string, unknown>();
  const env = {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "fake-management-key", POOL_APP_SIGNING_KEY: signingKey, POOL_IMAGE_HASH: "fake-image",
  };
  const container = new PoolContainer({ container: {}, storage: {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
  } }, env);
  const workerEnv = { ...env, PoolContainer: { jurisdiction: (region: string) => {
    assert.equal(region, "eu");
    return { getByName: (name: string) => { assert.equal(name, "control-plane"); return container; } };
  } } };
  const now = Date.now();
  const envelope = await signEnvelope(signingKey, accessPrefix, { action: "audience", at: now, expiresAt: now + accessTtl,
    pools: [{ pool: "fake-pool", owner: "fake-owner", organization: "fake-org", name: "Pool", users: [] }] });
  const response = await poolWorker.fetch(new Request(`https://pool.example${accessPath}`, {
    method: "POST", body: JSON.stringify({ envelope }),
  }), workerEnv);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { revoked: 0, provisioned: 0 });
  const token = await signPoolToken(signingKey, { pool: "fake-pool", owner: "fake-owner", organization: "fake-org" });
  const denied = await poolWorker.fetch(new Request(`https://pool.example${accessPath}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ envelope: token }),
  }), workerEnv);
  assert.equal(denied.status, 401);
});

test("native pool use is required before control, setup and usage can reach Home", async () => {
  const signingKey = "ab".repeat(32);
  const claims = { pool: "fake-pool", owner: "fake-owner", organization: "fake-org" };
  const entry = { ...claims, name: "Pool", users: ["fake-member"], managers: ["fake-owner"],
    authorization: "executor-app-v1", ownerSource: "audience", pending: [], at: Date.now() };
  const values = new Map<string, unknown>([["pool-directory-v1", {
    pools: { [JSON.stringify(claims.pool)]: entry }, refusals: {}, people: {}, refusalsVersion: 2,
  }]]);
  const worker = new PoolContainer({ container: {}, storage: {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
  } }, {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "fake-management-key", POOL_APP_SIGNING_KEY: signingKey, POOL_IMAGE_HASH: "fake-image",
  });
  const token = await signPoolToken(signingKey, claims);
  for (const caller of ["fake-owner", "fake-stranger", undefined]) {
    for (const path of ["/pool/v1/pool", "/pool/v1/setup-context", "/pool/v1/usage/summary?days=7"]) {
      const response = await worker.fetch(new Request(`https://pool.example${path}`, {
        headers: { Authorization: `Bearer ${token}`, ...(caller ? { "x-signalbox-caller": caller } : {}) },
      }));
      assert.equal(response.status, 403, `${caller ?? "anonymous"} ${path}: ${await response.text()}`);
    }
  }
  const allowed = await worker.fetch(new Request("https://pool.example/pool/v1/setup-context", {
    headers: { Authorization: `Bearer ${token}`, "x-signalbox-caller": "fake-member" },
  }));
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const value = await allowed.json() as { pools: unknown };
  assert.deepEqual(value.pools, [{ id: claims.pool, name: "Pool", mine: false }]);
});

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

test("successful provider connection captures product events through the Durable Object waitUntil", async (t) => {
  const signingKey = "ab".repeat(32);
  const token = await signPoolToken(signingKey, { pool: "fake-pool", owner: "fake-owner", organization: "fake-org" });
  const storage = new Map<string, unknown>();
  const groups: { id: number; channel_name: string }[] = [];
  const members: { id: number; channel_group_id: number; auth_id: string }[] = [];
  const pending: Promise<unknown>[] = [];
  const captured: Record<string, unknown>[] = [];
  const release: ((response: Response) => void)[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://eu.i.posthog.com/batch/");
    const payload = JSON.parse(String(init?.body)) as { batch: Record<string, unknown>[] };
    captured.push(...payload.batch);
    return await new Promise<Response>((resolve) => release.push(resolve));
  });
  const container = {
    running: true,
    destroy: async () => { container.running = false; },
    start: () => { container.running = true; },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (port === 8318) return Response.json({ boot_id: "fake-boot", started_at: "2026-01-01T00:00:00Z" });
        assert.equal(port, 8327);
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const endpoint = path.slice("/v8/management".length);
        if (endpoint === "/credentials") return Response.json({ files: [] });
        if (endpoint === "/oauth/auth-url") return Response.json({ state: "fake-state", url: "https://login.example/start?redirect_uri=http%3A%2F%2Flocalhost%2Fend" });
        if (endpoint === "/oauth/status") return Response.json({ status: "ok", auth_id: "provider-account" });
        if (endpoint === "/channel-groups" && request.method === "POST") {
          const group = { id: 20, channel_name: "signalbox-pool-fake-pool" };
          groups.push(group);
          return Response.json({ channel_group: group });
        }
        if (endpoint === "/channel-groups") return Response.json({ channel_groups: groups });
        if (endpoint.startsWith("/channel-group-details") && request.method === "POST") {
          const body = await request.json() as { channel_group_id: number; auth_id: string };
          const member = { id: members.length + 1, ...body };
          members.push(member);
          return Response.json({ channel_group_detail: member });
        }
        if (endpoint.startsWith("/channel-group-details")) return Response.json({ channel_group_details: members });
        if (endpoint === "/credentials/quota/fetch") return Response.json({ accepted: true }, { status: 202 });
        throw new Error(`Unexpected management call ${path}`);
      } };
    },
  };
  const ctx = {
    container,
    waitUntil: (work: Promise<unknown>) => pending.push(work),
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); },
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  };
  const worker = new PoolContainer(ctx, {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "obviously-fake-management-key",
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_IMAGE_HASH: "fake-image",
    POSTHOG_PROJECT_KEY: "fake-posthog-key",
  });
  const headers = { Authorization: `Bearer ${token}`, "x-signalbox-caller": "fake-owner" };
  const startedResponse = await worker.fetch(new Request("https://pool.example/pool/v1/sign-ins", {
    method: "POST", headers, body: JSON.stringify({ provider: providers[0]!.id }),
  }));
  assert.equal(startedResponse.status, 200, await startedResponse.clone().text());
  const started = await startedResponse.json() as { session: string };
  const connectedResponse = await worker.fetch(new Request(`https://pool.example/pool/v1/sign-ins/status?session=${encodeURIComponent(started.session)}`, { headers }));
  assert.deepEqual(await connectedResponse.json(), { status: "connected", accountId: "provider-account" });

  assert.deepEqual(captured.map((event) => event.event), ["pool_created", "account_connected"]);
  assert.deepEqual(captured.map((event) => event.distinct_id), ["fake-owner", "fake-owner"]);
  assert.ok(captured.every((event) => {
    const properties = event.properties as Record<string, unknown>;
    return properties.$process_person_profile === false && properties.$geoip_disable === true
      && properties.ip === null && !Object.keys(properties).some((key) => /email|content|query|pool|provider/i.test(key));
  }));
  assert.ok(pending.length >= 2);

  for (const resolve of release) resolve(new Response(null, { status: 200 }));
  await Promise.all(pending);
});
