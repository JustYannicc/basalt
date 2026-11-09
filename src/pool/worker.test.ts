import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { openEnvelope, signEnvelope, signPoolToken } from "./token.ts";
import { membershipPrefix, type NativeMembershipPolicy } from "./membership-contract.ts";
import { runtimeRecoveryPrefix } from "./runtime-recovery.ts";
import { accessPath, accessPrefix, accessTtl } from "./access-contract.ts";

// Node has no Workers runtime; keep the actual Worker and lifecycle with platform adapters stubbed.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query() { return { rows: [{ active: false }] }; } async end() {} } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
// Keep Workers-only declarations out of the Node typecheck, like the runtime stub above.
const workerModule = "./worker.ts";
const {
  PoolContainer,
  PoolOperations,
  default: poolWorker,
}: {
  PoolContainer: new (
    ctx: object,
    env: object,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
    deploymentReady(): Promise<unknown>;
    deploymentIdentity(): Promise<unknown>;
  };
  PoolOperations: {
    prototype: { fetch(this: { env: object }, request: Request): Promise<Response> };
  };
  default: { fetch(request: Request, env: object): Promise<Response> };
} = await import(workerModule);
hooks.deregister();

const retainedMembershipHost = {
  fetch: async (input: string) => {
    if (new URL(input).pathname === "/api/internal/pool-organization")
      return new Response(null, { status: 204 });
    assert.equal(new URL(input).pathname, "/api/internal/pool-membership");
    return Response.json({
      pool: "fake-pool",
      organization: "fake-org",
      native: false,
      accounts: [],
    });
  },
};

test("operator calls require the named entrypoint and never enter the public pool routes", async () => {
  const calls: unknown[] = [];
  const plan = { total: 2, enabled: 1, pending: 1, writes: 2, digest: "a".repeat(64), limit: 50 };
  const env = {
    PoolContainer: {
      jurisdiction(region: string) {
        assert.equal(region, "eu");
        return {
          getByName(name: string) {
            assert.equal(name, "control-plane");
            return {
              async migrateCodexWebSockets(approved: unknown) {
                calls.push(approved);
                return {
                  ...plan,
                  applied: approved ? 2 : 0,
                  status: approved ? "complete" : "dry-run",
                };
              },
            };
          },
        };
      },
    },
  };
  const path = "https://pool.example/codex-websockets";
  assert.equal((await poolWorker.fetch(new Request(path), env)).status, 404);
  assert.equal(calls.length, 0);
  const invoke = (request: Request) => PoolOperations.prototype.fetch.call({ env }, request);
  assert.equal((await invoke(new Request(path))).status, 200);
  const approved = { digest: plan.digest, pending: plan.pending };
  assert.equal(
    (await invoke(new Request(path, { method: "POST", body: JSON.stringify(approved) }))).status,
    200,
  );
  assert.deepEqual(calls, [undefined, approved]);
  assert.equal((await invoke(new Request(path, { method: "POST", body: "{}" }))).status, 400);
  assert.equal(calls.length, 2);
});

test("runtime recovery is only reachable through the named private operator entrypoint", async () => {
  let reads = 0;
  const env = {
    PoolContainer: {
      jurisdiction() {
        return {
          getByName() {
            return {
              fetch: async () => {
                reads++;
                return Response.json({
                  instanceId: "a".repeat(64),
                  imageHash: "synthetic",
                  ready: false,
                  running: true,
                });
              },
            };
          },
        };
      },
    },
  };
  const request = new Request("https://pool.example/runtime-recovery");
  assert.equal((await poolWorker.fetch(request, env)).status, 404);
  assert.equal(reads, 0);
  const response = await PoolOperations.prototype.fetch.call({ env }, request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, false);
  assert.equal(reads, 1);
});

test("the owner controller restarts the exact runtime once and serves models after recovery", async () => {
  const values = new Map<string, unknown>();
  let starts = 0,
    destroys = 0;
  const key = "ab".repeat(32),
    instanceId = "a".repeat(64),
    imageHash = "synthetic-image";
  const container = {
    running: true,
    start() {
      this.running = true;
      starts++;
    },
    async destroy() {
      this.running = false;
      destroys++;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async () =>
          port === 8318
            ? Response.json({ boot_id: `boot-${starts}`, started_at: "2026-11-04T00:00:00Z" })
            : Response.json({ data: [{ id: "synthetic-model" }] }),
      };
    },
  };
  const worker = new PoolContainer(
    {
      id: { toString: () => instanceId },
      container,
      waitUntil: () => {},
      storage: {
        get: async (name: string) => structuredClone(values.get(name)),
        put: async (name: string, value: unknown) => {
          values.set(name, structuredClone(value));
        },
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
    },
    {
      POOL_DATABASE_URL: "postgres://fixture",
      POOL_MANAGEMENT_KEY: "fixture",
      POOL_APP_SIGNING_KEY: key,
      POOL_IMAGE_HASH: imageHash,
    },
  );
  const env = {
    PoolContainer: {
      jurisdiction() {
        return {
          getByName() {
            return worker;
          },
        };
      },
    },
  };
  const at = Date.now(),
    operationId = crypto.randomUUID();
  const envelope = await signEnvelope(key, runtimeRecoveryPrefix, {
    version: 1,
    action: "restart",
    operationId,
    instanceId,
    imageHash,
    at,
    expiresAt: at + 60_000,
  });
  const request = () =>
    new Request("https://pool/runtime-recovery", {
      method: "POST",
      body: JSON.stringify({ envelope }),
    });
  assert.equal((await poolWorker.fetch(request(), env)).status, 404);
  const invoke = () => PoolOperations.prototype.fetch.call({ env }, request());
  for (const response of await Promise.all([invoke(), invoke()])) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ready");
  }
  assert.equal(starts, 1);
  assert.equal(destroys, 1);
  const response = await worker.fetch(new Request("https://pool/v1/models"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: "synthetic-model" }] });
});

test("the Durable Object alarm provisions pending pool members", async () => {
  const pool = {
    pool: "fake-pool",
    owner: "fake-owner",
    organization: "fake-org",
    name: "Pool",
    users: ["fake-owner", "fake-member"],
    pending: ["fake-member"],
    at: Date.now(),
  };
  const values = new Map<string, unknown>([
    [
      "pool-directory-v1",
      {
        pools: { [JSON.stringify(pool.pool)]: pool },
        refusals: {},
        people: {},
        refusalsVersion: 2,
      },
    ],
  ]);
  const users: Record<string, unknown>[] = [];
  let alarm: number | null = null;
  const runtime = {
    running: false,
    destroy: async () => {
      runtime.running = false;
    },
    start: () => {
      runtime.running = true;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (port === 8318)
            return Response.json({ boot_id: "fake-boot", started_at: "2026-01-01T00:00:00Z" });
          const request = new Request(input, init);
          assert.equal(new URL(request.url).pathname, "/v8/management/users");
          if (request.method === "POST")
            users.push({ ...((await request.json()) as object), id: 42 });
          return Response.json({ users });
        },
      };
    },
  };
  const worker = new PoolContainer(
    {
      container: runtime,
      waitUntil: () => {},
      storage: {
        get: async (key: string) => structuredClone(values.get(key)),
        put: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value));
        },
        getAlarm: async () => alarm,
        setAlarm: async (time: number) => {
          alarm = time;
        },
      },
    },
    {
      POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
      POOL_MANAGEMENT_KEY: "fake-management-key",
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      POOL_IMAGE_HASH: "fake-image",
    },
  );
  await worker.alarm();
  assert.equal(users.length, 1);
  const state = values.get("pool-directory-v1") as {
    pools: Record<string, { pending: string[]; provisioned: string[] }>;
  };
  assert.deepEqual(state.pools[JSON.stringify(pool.pool)]!.pending, []);
  assert.deepEqual(state.pools[JSON.stringify(pool.pool)]!.provisioned, ["fake-member"]);
  assert.ok(alarm);
});

test("a restarted object keeps an already running container alive before any request", async () => {
  const env = {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "fake-management-key",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: "fake-image",
  };
  const timeouts: number[] = [];
  const pending: Promise<unknown>[] = [];
  const object = (running: boolean) =>
    new PoolContainer(
      {
        container: {
          running,
          setInactivityTimeout: async (ms: number) => {
            timeouts.push(ms);
          },
        },
        waitUntil: (work: Promise<unknown>) => {
          pending.push(work);
        },
        storage: { get: async () => undefined, put: async () => {} },
      },
      env,
    );
  object(true);
  await Promise.all(pending);
  // The same two hours a warm start sets; an object with no request to serve never warms.
  assert.deepEqual(timeouts, [2 * 60 * 60_000]);
  object(false);
  await Promise.all(pending);
  assert.equal(timeouts.length, 1);
});

test("signed access changes reach the computer queue before generic pool-token control routing", async () => {
  const signingKey = "ab".repeat(32);
  const values = new Map<string, unknown>();
  const env = {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "fake-management-key",
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_IMAGE_HASH: "fake-image",
    TOOLS_SERVICE: { fetch: async () => new Response(null, { status: 204 }) },
  };
  const container = new PoolContainer(
    {
      container: {},
      storage: {
        get: async (key: string) => structuredClone(values.get(key)),
        put: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value));
        },
      },
    },
    env,
  );
  const workerEnv = {
    ...env,
    PoolContainer: {
      jurisdiction: (region: string) => {
        assert.equal(region, "eu");
        return {
          getByName: (name: string) => {
            assert.equal(name, "control-plane");
            return container;
          },
        };
      },
    },
  };
  const now = Date.now();
  const envelope = await signEnvelope(signingKey, accessPrefix, {
    action: "audience",
    at: now,
    expiresAt: now + accessTtl,
    pools: [
      { pool: "fake-pool", owner: "fake-owner", organization: "fake-org", name: "Pool", users: [] },
    ],
  });
  const response = await poolWorker.fetch(
    new Request(`https://pool.example${accessPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    workerEnv,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { revoked: 0, provisioned: 0 });
  const token = await signPoolToken(signingKey, {
    pool: "fake-pool",
    owner: "fake-owner",
    organization: "fake-org",
  });
  const denied = await poolWorker.fetch(
    new Request(`https://pool.example${accessPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope: token }),
    }),
    workerEnv,
  );
  assert.equal(denied.status, 401);
  values.set("native-pool-memberships-v1", {
    "fake-pool": {
      pool: "fake-pool",
      organization: "fake-org",
      revision: 1,
      expiresAt: now + 15_000,
      accounts: [],
      dirty: false,
      native: true,
      checkedAt: now,
      installedRevision: 1,
      installedUntil: now + 15_000,
    },
  });
  const deletion = await signEnvelope(signingKey, accessPrefix, {
    action: "pool-deleted",
    pool: "fake-pool",
    at: now,
    expiresAt: now + accessTtl,
  });
  const remove = await poolWorker.fetch(
    new Request(`https://pool.example${accessPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope: deletion }),
    }),
    workerEnv,
  );
  assert.equal(remove.status, 200, await remove.clone().text());
  const membership = values.get("native-pool-memberships-v1") as Record<
    string,
    {
      dirty: boolean;
      retired?: { resumeAfter: number };
    }
  >;
  assert.equal(membership["fake-pool"]?.dirty, true);
  assert.ok(membership["fake-pool"]?.retired);
});

test("native pool use is required before control, setup and usage can reach Home", async () => {
  const signingKey = "ab".repeat(32);
  const claims = { pool: "fake-pool", owner: "fake-owner", organization: "fake-org" };
  const entry = {
    ...claims,
    name: "Pool",
    users: ["fake-member"],
    managers: ["fake-owner"],
    authorization: "executor-app-v1",
    ownerSource: "audience",
    pending: [],
    at: Date.now(),
  };
  const values = new Map<string, unknown>([
    [
      "pool-directory-v1",
      {
        pools: { [JSON.stringify(claims.pool)]: entry },
        refusals: {},
        people: {},
        refusalsVersion: 2,
      },
    ],
  ]);
  const worker = new PoolContainer(
    {
      container: {},
      waitUntil: () => {},
      storage: {
        get: async (key: string) => structuredClone(values.get(key)),
        put: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value));
        },
      },
    },
    {
      POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
      POOL_MANAGEMENT_KEY: "fake-management-key",
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_IMAGE_HASH: "fake-image",
      TOOLS_SERVICE: retainedMembershipHost,
    },
  );
  const token = await signPoolToken(signingKey, claims);
  for (const caller of ["fake-owner", "fake-stranger", undefined]) {
    for (const path of [
      "/pool/v1/pool",
      "/pool/v1/setup-context",
      "/pool/v1/usage/summary?days=7",
    ]) {
      const response = await worker.fetch(
        new Request(`https://pool.example${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(caller ? { "x-signalbox-caller": caller } : {}),
          },
        }),
      );
      assert.equal(
        response.status,
        403,
        `${caller ?? "anonymous"} ${path}: ${await response.text()}`,
      );
    }
  }
  const allowed = await worker.fetch(
    new Request("https://pool.example/pool/v1/setup-context", {
      headers: { Authorization: `Bearer ${token}`, "x-signalbox-caller": "fake-member" },
    }),
  );
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const value = (await allowed.json()) as { pools: unknown };
  assert.deepEqual(value.pools, [{ id: claims.pool, name: "Pool", mine: false }]);
});

test("opening Connect starts a stopped pool without waiting for it, and only for an authorized read", async () => {
  const signingKey = "ab".repeat(32);
  const claims = { pool: "fake-pool", owner: "fake-owner", organization: "fake-org" };
  const entry = {
    ...claims,
    name: "Pool",
    users: ["fake-member"],
    managers: ["fake-owner"],
    authorization: "executor-app-v1",
    ownerSource: "audience",
    pending: [],
    at: Date.now(),
  };
  const values = new Map<string, unknown>([
    [
      "pool-directory-v1",
      {
        pools: { [JSON.stringify(claims.pool)]: entry },
        refusals: {},
        people: {},
        refusalsVersion: 2,
      },
    ],
  ]);
  let starts = 0;
  let destroys = 0;
  let ready = false;
  let started!: () => void;
  const startedOnce = new Promise<void>((resolve) => {
    started = resolve;
  });
  const container = {
    running: false,
    destroy: async () => {
      destroys++;
      container.running = false;
    },
    start: () => {
      starts++;
      container.running = true;
      started();
    },
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({
      fetch: async () =>
        ready
          ? Response.json({ boot_id: "fake-boot", started_at: "2026-01-01T00:00:00Z" })
          : new Response(null, { status: 503 }),
    }),
  };
  const background: Promise<unknown>[] = [];
  const worker = new PoolContainer(
    {
      container,
      waitUntil: (work: Promise<unknown>) => {
        background.push(work);
      },
      storage: {
        get: async (key: string) => structuredClone(values.get(key)),
        put: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value));
        },
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
    },
    {
      POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
      POOL_MANAGEMENT_KEY: "fake-management-key",
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_IMAGE_HASH: "fake-image",
      TOOLS_SERVICE: retainedMembershipHost,
    },
  );
  const token = await signPoolToken(signingKey, claims);
  const read = (headers: Record<string, string>) =>
    worker.fetch(new Request("https://pool.example/pool/v1/setup-context", { headers }));
  // Rejected reads never touch the shared container.
  for (const headers of [
    {} as Record<string, string>,
    { Authorization: "Bearer not-a-token", "x-signalbox-caller": "fake-member" },
    { Authorization: `Bearer ${token}`, "x-signalbox-caller": "fake-stranger" },
  ]) {
    const rejected = await read(headers);
    assert.ok(rejected.status === 401 || rejected.status === 403, String(rejected.status));
  }
  assert.equal(background.length, 0);
  assert.equal(starts, 0);
  assert.equal(destroys, 0);
  const response = await read({
    Authorization: `Bearer ${token}`,
    "x-signalbox-caller": "fake-member",
  });
  // The page gets its context while the pool is still booting.
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(background.length, 1);
  await startedOnce;
  ready = true;
  await Promise.all(background);
  assert.equal(starts, 1);
  assert.equal(destroys, 0);
});

test("management calls share readiness for 30 seconds and rewarm when the container stops", async (t) => {
  const signingKey = "ab".repeat(32);
  const token = await signPoolToken(signingKey, {
    pool: "fake-pool",
    owner: "fake-owner",
    organization: "fake-org",
  });
  const storage = new Map<string, unknown>();
  let alarm: number | null = null;
  let ready = 0;
  let starts = 0;
  let management = 0;
  const container = {
    running: true,
    destroy: async () => {
      container.running = false;
    },
    start: () => {
      starts++;
      container.running = true;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (port === 8318) {
            ready++;
            return Response.json({ boot_id: "fake-boot", started_at: "2026-01-01T00:00:00Z" });
          }
          assert.equal(port, 8327);
          const request = new Request(input, init);
          assert.equal(request.headers.get("X-Management-Key"), "obviously-fake-management-key");
          assert.notEqual(request.headers.get("Authorization"), `Bearer ${token}`);
          management++;
          const path = new URL(request.url).pathname;
          if (path.endsWith("/oauth/session"))
            return Response.json({ status: "ok", cancelled: true });
          if (path.endsWith("/credentials")) return Response.json({ files: [] });
          if (path.endsWith("/oauth/auth-url"))
            return Response.json({
              state: `fake-state-${management}`,
              url: "https://login.example/start?redirect_uri=http%3A%2F%2Flocalhost%2Fend",
            });
          if (path.endsWith("/channel-groups")) return Response.json({ channel_groups: [] });
          throw new Error(`Unexpected management call ${path}`);
        },
      };
    },
  };
  const ctx = {
    container,
    waitUntil: () => {},
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => {
        alarm = time;
      },
    },
  };
  // Only the native runtime's constructor types are substituted in this Node test.
  const worker = new PoolContainer(ctx, {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "obviously-fake-management-key",
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_IMAGE_HASH: "fake-image",
    TOOLS_SERVICE: retainedMembershipHost,
  });
  async function read() {
    const response = await worker.fetch(
      new Request("https://pool.example/pool/v1/pool?fresh=true", {
        headers: { Authorization: `Bearer ${token}`, "x-signalbox-caller": "fake-owner" },
      }),
    );
    assert.equal(response.status, 200, await response.text());
  }
  t.mock.timers.enable({ apis: ["Date"] });
  await read();
  assert.equal(management, 2);
  assert.equal(ready, 1);
  await read();
  assert.equal(ready, 1);
  t.mock.timers.tick(30_001);
  await read();
  assert.equal(ready, 2);
  container.running = false;
  await read();
  assert.equal(ready, 3);
  assert.equal(starts, 2);
  const deletion = await signEnvelope(signingKey, accessPrefix, {
    action: "pool-deleted",
    pool: "fake-pool",
    at: Date.now(),
    expiresAt: Date.now() + accessTtl,
  });
  const removed = await worker.fetch(
    new Request(`https://pool.example${accessPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope: deletion }),
    }),
  );
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(storage.has("native-pool-memberships-v1"), false);
  await read();
  assert.equal(
    storage.has("native-pool-memberships-v1"),
    false,
    "retained native:false reads keep their existing behavior after a rolled-back removal",
  );
});

test("old pool tools cannot acquire credentials or start the runtime through the Worker", async () => {
  const signingKey = "ab".repeat(32);
  const token = await signPoolToken(signingKey, {
    pool: "fake-pool",
    owner: "fake-owner",
    organization: "fake-org",
  });
  let backendCalls = 0;
  const ctx = {
    container: {
      running: false,
      start() {
        backendCalls++;
      },
      getTcpPort() {
        backendCalls++;
        throw new Error("Acquisition must not reach the backend");
      },
    },
    waitUntil: () => {},
    storage: {
      get: async () => undefined,
      put: async () => {},
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  };
  const worker = new PoolContainer(ctx, {
    POOL_DATABASE_URL: "postgres://fake:fake@database.invalid/fake",
    POOL_MANAGEMENT_KEY: "obviously-fake-management-key",
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_IMAGE_HASH: "fake-image",
    TOOLS_SERVICE: {
      fetch: async (input: string) => {
        if (new URL(input).pathname === "/api/internal/pool-organization")
          return new Response(null, { status: 204 });
        throw new Error("Blocked acquisition must not read native membership");
      },
    },
  });
  for (const [method, path] of [
    ["POST", "sign-ins"],
    ["POST", "login-files"],
    ["POST", "sign-ins/callback"],
    ["GET", "sign-ins/status?session=old"],
  ]) {
    const response = await worker.fetch(
      new Request(`https://pool.example/pool/v1/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "x-signalbox-caller": "fake-owner" },
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "ProviderAppConnectionRequired",
    );
  }
  assert.equal(backendCalls, 0);
});

test("an unhealthy warm runtime returns a retryable 503 before another model dispatch and recovers", async () => {
  const values = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const errors: unknown[][] = [];
  let healthy = true,
    modelCalls = 0,
    readinessCalls = 0,
    alarm: number | null = null;
  const container = {
    running: false,
    start() {
      this.running = true;
    },
    destroy: async () => {},
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async () => {
          if (port === 8318) {
            readinessCalls += 1;
            return healthy
              ? Response.json({ boot_id: "fixture", started_at: "2026-10-31T12:00:00Z" })
              : new Response(null, { status: 503 });
          }
          assert.equal(port, 8317);
          modelCalls += 1;
          return Response.json({ data: [] });
        },
      };
    },
  };
  const worker = new PoolContainer(
    {
      container,
      waitUntil: (work: Promise<unknown>) => {
        background.push(work);
      },
      storage: {
        get: async (name: string) => structuredClone(values.get(name)),
        put: async (name: string, value: unknown) => {
          values.set(name, structuredClone(value));
        },
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => {
          alarm = at;
        },
      },
    },
    {
      POOL_DATABASE_URL: "postgres://fixture",
      POOL_MANAGEMENT_KEY: "fixture",
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      POOL_IMAGE_HASH: "fixture",
      POOL_MODEL_HISTORY_ENABLED: "false",
    },
  );
  const request = () =>
    new Request("https://pool.example/v1/models", {
      headers: { Authorization: "Bearer synthetic-private-key" },
    });
  assert.equal((await worker.fetch(request())).status, 200);
  healthy = false;
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const response = await worker.fetch(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "2");
    assert.ok(response.headers.get("X-Request-Id"));
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    assert.equal(body.error.code, "pool_protection_unavailable");
    assert.equal(body.error.retryable, true);
    assert.equal(readinessCalls, 2, "warm failure does not enter the cold retry loop");
    assert.equal(modelCalls, 1, "unhealthy readiness prevents model dispatch");
    assert.match(JSON.stringify(errors), /POOL_GATEWAY_FAILURE/);
    assert.partialDeepStrictEqual(
      errors.find((entry) => entry[0] === "POOL_GATEWAY_FAILURE")?.[1],
      {
        guard: "runtime_readiness",
        cause: "PoolRuntimeUnhealthy",
      },
    );
    assert.ok(!JSON.stringify(errors).includes("synthetic-private-key"));
    healthy = true;
    assert.equal((await worker.fetch(request())).status, 200);
    assert.equal(modelCalls, 2);
    await Promise.all(background);
  } finally {
    console.error = originalError;
  }
});

for (const retire of [false, true])
  test(
    retire
      ? "signed deletion stops background upkeep and a confirmed rollback recovers through a fresh reservation"
      : "an alarm joining background membership upkeep restores its consumed short deadline",
    async (t) => {
      const start = Date.now(),
        key = "ab".repeat(32);
      t.mock.timers.enable({ apis: ["Date"], now: start });
      const values = new Map<string, unknown>(),
        background: Promise<unknown>[] = [];
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const installed: NativeMembershipPolicy[] = [];
      let alarm: number | null = null,
        reads = 0,
        native = true;
      if (retire)
        values.set("native-pool-memberships-v1", {
          a: {
            pool: "a",
            organization: "org",
            revision: 1,
            expiresAt: start + 15_000,
            accounts: [],
            dirty: false,
            native: true,
            checkedAt: start,
            installedRevision: 1,
            installedUntil: start + 15_000,
          },
        });
      const worker = new PoolContainer(
        {
          container: {
            running: true,
            start() {
              this.running = true;
            },
            async destroy() {
              this.running = false;
            },
            setInactivityTimeout: async () => {},
            getTcpPort(port: number) {
              return {
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                  const request = new Request(input, init),
                    path = new URL(request.url).pathname;
                  if (port === 8318) {
                    if (path === "/native-policy") {
                      const { projection } = (await request.json()) as { projection: string };
                      const policy = (await openEnvelope(
                        key,
                        "sbm-policy1",
                        projection,
                      )) as NativeMembershipPolicy;
                      assert.ok(policy);
                      installed.push(policy);
                      return Response.json({ installed: true, revision: policy.revision });
                    }
                    assert.equal(path, "/ready");
                    return Response.json({
                      boot_id: "fake-boot",
                      started_at: "2026-11-09T00:00:00Z",
                    });
                  }
                  assert.equal(port, 8327);
                  if (path === "/v8/management/channel-groups")
                    return Response.json({
                      channel_groups: [{ id: 1, channel_name: "signalbox-pool-a" }],
                    });
                  if (path === "/v8/management/channel-group-details")
                    return Response.json({ channel_group_details: [] });
                  if (path === "/v8/management/models") return Response.json({ models: [] });
                  if (path === "/v8/management/billing/model-prices")
                    return Response.json({ items: [] });
                  if (path === "/v8/management/capabilities")
                    return Response.json({ capabilities: {} });
                  if (path === "/v8/management/usage/records")
                    return Response.json({ items: [], total: 0 });
                  assert.fail(`Unexpected Home request: ${path}`);
                },
              };
            },
          },
          waitUntil: (work: Promise<unknown>) => {
            background.push(work);
          },
          storage: {
            get: async (name: string) => structuredClone(values.get(name)),
            put: async (name: string, value: unknown) => {
              values.set(name, structuredClone(value));
            },
            getAlarm: async () => alarm,
            setAlarm: async (at: number) => {
              alarm = at;
            },
          },
        },
        {
          POOL_DATABASE_URL: "postgres://fixture",
          POOL_MANAGEMENT_KEY: "fixture",
          POOL_APP_SIGNING_KEY: key,
          POOL_IMAGE_HASH: "fixture",
          TOOLS_SERVICE: {
            fetch: async (input: string) => {
              const path = new URL(input).pathname;
              if (path === "/api/internal/pool-organization")
                return new Response(null, { status: 204 });
              if (path === "/api/internal/account-observations/refresh")
                return new Response(null, { status: 204 });
              assert.equal(path, "/api/internal/pool-membership");
              reads++;
              entered.resolve();
              await release.promise;
              return Response.json({ pool: "a", organization: "org", native, accounts: [] });
            },
          },
        },
      );
      const response = await worker.fetch(
        new Request("https://pool/pool/v1/membership", {
          method: "POST",
          body: JSON.stringify({
            envelope: await signEnvelope(key, membershipPrefix, {
              pool: "a",
              organization: "org",
              at: start,
              expiresAt: start + 30_000,
            }),
          }),
        }),
      );
      assert.equal(response.status, 204);
      await entered.promise;
      assert.equal(alarm, start + 5_000);
      if (retire) {
        const deletion = await signEnvelope(key, accessPrefix, {
          action: "pool-deleted",
          pool: "a",
          at: Date.now(),
          expiresAt: Date.now() + accessTtl,
        });
        const removed = await worker.fetch(
          new Request(`https://pool${accessPath}`, {
            method: "POST",
            body: JSON.stringify({ envelope: deletion }),
          }),
        );
        assert.equal(removed.status, 200, await removed.clone().text());
        native = false;
      }
      t.mock.timers.tick(5_000);
      // Cloudflare consumes the stored deadline before invoking the alarm handler.
      alarm = null;
      const firing = worker.alarm();
      t.mock.timers.tick(8_800);
      release.resolve();
      await Promise.all([firing, ...background]);
      assert.equal(reads, 1, "the alarm must join the background repair");
      if (retire) {
        assert.equal(installed.at(-1)?.dirty, true);
        assert.equal(alarm, Date.now() + 300_000, "only runtime upkeep remains after deletion");
        t.mock.timers.tick(60_000);
        alarm = null;
        await worker.alarm();
        assert.equal(reads, 1, "retired pools must not be read by later alarms");
        const reserve = async () => {
          const envelope = await signEnvelope(key, membershipPrefix, {
            pool: "a",
            organization: "org",
            at: Date.now(),
            expiresAt: Date.now() + 30_000,
          });
          const response = await worker.fetch(
            new Request("https://pool/pool/v1/membership", {
              method: "POST",
              body: JSON.stringify({ envelope }),
            }),
          );
          assert.equal(response.status, 204);
          await Promise.all(background);
        };
        await reserve();
        assert.equal(
          installed.at(-1)?.dirty,
          true,
          "an absent host registration cannot reactivate",
        );
        assert.equal(alarm, Date.now() + 300_000);
        native = true;
        t.mock.timers.tick(1);
        await reserve();
        assert.equal(
          installed.at(-1)?.dirty,
          false,
          "a fresh host confirmation repairs a rollback",
        );
        assert.equal(alarm, Date.now() + 5_000);
        return;
      }
      assert.equal(alarm, start + 18_800, "completion must restore the five-second cadence");
      assert.equal(installed.at(-1)?.dirty, false);
      const firstExpiry = installed.at(-1)!.expiresAt;
      t.mock.timers.tick(5_000);
      alarm = null;
      await worker.alarm();
      assert.equal(reads, 2, "the restored alarm must perform a fresh repair");
      assert.ok(installed.at(-1)!.expiresAt > firstExpiry, "the next pass renews native authority");
      assert.equal(alarm, Date.now() + 5_000);
    },
  );

test("native SQL writes to a running container require the exact policy install acknowledgement", async () => {
  const key = "ab".repeat(32),
    values = new Map<string, unknown>(),
    background: Promise<unknown>[] = [];
  let acknowledgement: unknown = { installed: true, revision: 999 },
    alarm: number | null = null;
  const container = {
    running: true,
    start() {
      this.running = true;
    },
    destroy: async () => {},
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          assert.equal(port, 8318);
          assert.equal(new URL(request.url).pathname, "/native-policy");
          const body = (await request.json()) as { projection: string };
          const projection = JSON.parse(
            atob(body.projection.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
          ) as Record<string, unknown>;
          assert.deepEqual(Object.keys(projection).sort(), [
            "accounts",
            "dirty",
            "expiresAt",
            "organization",
            "pool",
            "revision",
          ]);
          return Response.json(acknowledgement);
        },
      };
    },
  };
  const worker = new PoolContainer(
    {
      container,
      waitUntil: (work: Promise<unknown>) => {
        background.push(work);
      },
      storage: {
        get: async (name: string) => structuredClone(values.get(name)),
        put: async (name: string, value: unknown) => {
          values.set(name, structuredClone(value));
        },
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => {
          alarm = at;
        },
      },
    },
    {
      POOL_DATABASE_URL: "postgres://fixture",
      POOL_MANAGEMENT_KEY: "fixture",
      POOL_APP_SIGNING_KEY: key,
      POOL_IMAGE_HASH: "fixture",
      TOOLS_SERVICE: { fetch: async () => new Response(null, { status: 503 }) },
    },
  );
  const request = async () => {
    const now = Date.now();
    return new Request("https://pool/pool/v1/membership", {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(key, "sbm1", {
          pool: "a",
          organization: "org",
          at: now,
          expiresAt: now + 30_000,
        }),
      }),
    });
  };
  assert.equal((await worker.fetch(await request())).status, 503);
  acknowledgement = { installed: true, revision: 2 };
  assert.equal((await worker.fetch(await request())).status, 204);
  await Promise.all(background);
});

test("uncertain container model sends suppress retries while definite Home refusals pass through", async () => {
  const values = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const paths = [
    "/v1/responses",
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/systemone",
    "/typesafe/v1/systemone",
  ];
  let sends = 0,
    refuse = false;
  const container = {
    running: false,
    start() {
      this.running = true;
    },
    destroy: async () => {},
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (request: Request) => {
          if (port === 8318)
            return Response.json({ boot_id: "synthetic-boot", started_at: "2026-10-31T00:00:00Z" });
          assert.equal(port, 8317);
          sends++;
          assert.equal(await request.text(), '{"state":"synthetic-unknown"}');
          if (refuse)
            return Response.json(
              { error: "auth_unavailable" },
              { status: 503, headers: { "Retry-After": "7" } },
            );
          throw new Error("synthetic transport loss after accepting request");
        },
      };
    },
  };
  const worker = new PoolContainer(
    {
      container,
      waitUntil: (work: Promise<unknown>) => {
        background.push(work);
      },
      storage: {
        get: async (name: string) => structuredClone(values.get(name)),
        put: async (name: string, value: unknown) => {
          values.set(name, structuredClone(value));
        },
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
    },
    {
      POOL_DATABASE_URL: "postgres://fixture",
      POOL_MANAGEMENT_KEY: "fixture",
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      POOL_IMAGE_HASH: "fixture",
      POOL_MODEL_HISTORY_ENABLED: "false",
    },
  );
  for (const path of paths) {
    const before = sends;
    const response = await worker.fetch(
      new Request(`https://pool.example${path}`, {
        method: "POST",
        body: '{"state":"synthetic-unknown"}',
      }),
    );
    assert.equal(response.status, 502, path);
    assert.equal(response.headers.get("x-should-retry"), "false");
    assert.equal(response.headers.get("retry-after"), null);
    assert.equal(response.headers.get("retry-after-ms"), null);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    assert.equal(body.error.code, "upstream_outcome_unknown");
    assert.equal(body.error.retryable, false);
    assert.equal(sends, before + 1);
  }
  refuse = true;
  const response = await worker.fetch(
    new Request("https://pool.example/v1/responses", {
      method: "POST",
      body: '{"state":"synthetic-unknown"}',
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(response.headers.get("x-should-retry"), null);
  await Promise.all(background);
});

test("the Worker answers its release without waking the pool container", async () => {
  const env = {
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    PoolContainer: {
      jurisdiction() {
        throw new Error("The release route must not reach the container");
      },
    },
  };
  const response = await poolWorker.fetch(new Request("https://pool.example/pool/v1/release"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys((await response.json()) as object).sort(), [
    "keyVersion",
    "revision",
  ]);
});

test("deployment readiness cannot be invoked on public routes or without the release signature", async () => {
  let warms = 0;
  const env = {
    POOL_DEPLOYMENT_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1234abcd",
    PoolContainer: {
      jurisdiction() {
        return {
          getByName() {
            return {
              async deploymentReady() {
                warms++;
                throw new Error("must not warm");
              },
            };
          },
        };
      },
    },
  };
  for (const method of ["GET", "POST"]) {
    const request = new Request("https://pool.example/deployment-readiness", { method });
    assert.equal((await poolWorker.fetch(request, env)).status, 404);
    assert.notEqual((await PoolOperations.prototype.fetch.call({ env }, request)).status, 200);
  }
  assert.equal(warms, 0);
});

test("the actual controller reports its code identity without reading startup state", async () => {
  const { productionOpsRelease } =
    await import("../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts");
  const { poolWorkerRevision } =
    await import("../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts");
  const instanceId = "d".repeat(64);
  const pool = new PoolContainer(
    {
      id: { toString: () => instanceId },
      storage: {
        get() {
          throw new Error("Code identity must not read startup state");
        },
        put() {
          throw new Error("Code identity must not write startup state");
        },
      },
      container: { running: false },
    },
    {
      POOL_DATABASE_URL: "postgres://fixture:fixture@localhost/pool",
      POOL_IMAGE_HASH: "1234abcd",
      POOL_MANAGEMENT_KEY: "synthetic-management-key",
      POOL_APP_SIGNING_KEY: "a".repeat(64),
    },
  );
  assert.deepEqual(await pool.deploymentIdentity(), {
    candidate: productionOpsRelease,
    workerInput: poolWorkerRevision,
    imageHash: "1234abcd",
    instanceId,
  });
});

test("a deferred base controller receives no startup call from the signed adoption probe", async () => {
  const { productionOpsRelease } =
    await import("../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts");
  const { poolWorkerRevision } =
    await import("../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts");
  const target = {
    candidate: productionOpsRelease,
    workerInput: poolWorkerRevision,
    imageHash: "1234abcd",
  };
  const key = "a".repeat(64);
  const identity = { ...target, instanceId: "d".repeat(64) };
  let warms = 0;
  const oldController = {
    async deploymentReady() {
      // The pinned base has this startup RPC and no identity-only RPC.
      warms++;
      throw new Error("Old revision must never start during adoption");
    },
  };
  let controller: object = oldController;
  const env = {
    POOL_DEPLOYMENT_KEY: key,
    POOL_IMAGE_HASH: target.imageHash,
    PoolContainer: {
      jurisdiction: () => ({ getByName: () => controller }),
    },
  };
  const request = async () =>
    new Request("https://private.invalid/deployment-readiness", {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(key, "sbpdr1", {
          ...target,
          phase: "adoption",
          at: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
      }),
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await PoolOperations.prototype.fetch.call({ env }, await request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { outcome: "readiness-error", stage: "readiness" });
    assert.equal(warms, 0);
  }
  controller = { ...oldController, deploymentIdentity: async () => identity };
  const adopted = await PoolOperations.prototype.fetch.call({ env }, await request());
  assert.equal(adopted.status, 200);
  assert.deepEqual(await adopted.json(), identity);
  assert.equal(warms, 0);
});
