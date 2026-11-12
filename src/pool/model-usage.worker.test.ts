import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query(text, values) { return { rows: text.includes('SELECT k.id') ? [{ id: String(values[0]).endsWith('74') ? 74 : 73, channels: [], username: null }] : [{ active: false }] }; } async end() {} } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
// The Worker gets its platform declarations in tsconfig.worker.json.
const workerModule = "./worker.ts";
const {
  PoolContainer,
}: {
  PoolContainer: new (
    ctx: object,
    env: object,
  ) => {
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
  };
} = await import(workerModule);
after(() => hooks.deregister());

test("model responses reconcile successful Home usage without listing; alarm retries delayed usage", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-12T12:00:00Z") });
  const signingKey = "ab".repeat(32);
  const storage = new Map<string, unknown>();
  const waitUntil: Promise<unknown>[] = [];
  const analyticsBodies: string[] = [];
  const homeUsage = new Set<number>();
  const homeReads: number[] = [];
  const pool = "fake-pool";
  const credential = "provider-account";
  const computers = [73, 74, 75].map((keyId, index) => {
    const user = ["response-owner", "delayed-owner", "failed-owner"][index]!;
    return [
      `computer-${keyId}`,
      {
        id: `computer-${keyId}`,
        name: "Fixture",
        user,
        pool,
        createdAt: "2026-01-01T00:00:00.000Z",
        boundAt: "2026-01-01T00:00:00.000Z",
        state: "active",
        keyId,
        userId: index + 1,
        toolsKeyId: `tools-key-${keyId}`,
        toolsHash: `tools-hash-${keyId}`,
        firstModelRequestAt: null,
        firstToolCallAt: null,
        revokedAt: null,
      },
    ];
  });
  storage.set("computer-registry-v1", Object.fromEntries(computers));

  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://eu.i.posthog.com/batch/");
    analyticsBodies.push(String(init?.body));
    return new Response(null, { status: 200 });
  });

  const container = {
    running: true,
    destroy: async () => {
      container.running = false;
    },
    start: () => {
      container.running = true;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (port === 8318)
            return Response.json({ boot_id: "fixture-boot", started_at: "2026-01-01T00:00:00Z" });
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (port === 8317) {
            if (request.method === "GET" && path === "/v1/models")
              return Response.json({ data: [] });
            if (request.method === "POST" && path === "/v1/responses") {
              homeUsage.add(73);
              return Response.json({ ok: true });
            }
            if (request.method === "POST" && path === "/messages")
              return Response.json({ ok: true });
            if (request.method === "POST" && path === "/chat/completions")
              return Response.json({ error: "failed" }, { status: 502 });
            return new Response(null, { status: 404 });
          }
          assert.equal(port, 8327);
          const endpoint = path.slice("/v8/management".length);
          if (endpoint === "/channel-groups")
            return Response.json({
              channel_groups: [{ id: 20, channel_name: `signalbox-pool-${pool}` }],
            });
          if (endpoint.startsWith("/channel-group-details"))
            return Response.json({
              channel_group_details: [{ id: 1, channel_group_id: 20, auth_id: credential }],
            });
          if (endpoint.startsWith("/usage/records")) {
            const keyId = Number(new URL(request.url).searchParams.get("client_key_id"));
            homeReads.push(keyId);
            const items = homeUsage.has(keyId)
              ? [
                  {
                    id: `usage-${keyId}`,
                    status: "success",
                    timestamp: "2026-01-02T00:00:00.000Z",
                    credential: { credential_id: credential },
                    client: { api_key_id: keyId },
                  },
                ]
              : [];
            return Response.json({ items, total: items.length, limit: 20, offset: 0 });
          }
          throw new Error(`Unexpected management request ${path}`);
        },
      };
    },
  };
  const ctx = {
    container,
    waitUntil: (work: Promise<unknown>) => {
      waitUntil.push(work);
    },
    storage: {
      get: async (key: string) =>
        storage.has(key) ? structuredClone(storage.get(key)) : undefined,
      put: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  };
  let publications = 0;
  const worker = new PoolContainer(ctx, {
    TOOLS_SERVICE: {
      fetch: async (url: string, init: RequestInit) => {
        assert.equal(new URL(url).pathname, "/api/internal/account-observations/refresh");
        assert.equal(init.method, "POST");
        publications++;
        return new Response(null, { status: 204 });
      },
    },
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
    POOL_MANAGEMENT_KEY: "fixture-management-key",
    POOL_AUTH_DATABASE: { connectionString: "postgres://fixture" },
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_IMAGE_HASH: "fixture-image",
    POSTHOG_PROJECT_KEY: "fixture-posthog-key",
  });
  const drain = async () => {
    for (let i = 0; i < waitUntil.length; i++) await waitUntil[i];
  };
  const trackedEvents = () =>
    analyticsBodies.flatMap((wire) => {
      const payload = JSON.parse(wire) as {
        batch?: { event: string; distinct_id: string }[];
        event?: string;
        distinct_id?: string;
      };
      return (
        payload.batch ??
        (payload.event && payload.distinct_id
          ? [{ event: payload.event, distinct_id: payload.distinct_id }]
          : [])
      );
    });

  const requestBody = "private-model-request-body";
  const modelRequest = (path: string, method = "POST") =>
    worker.fetch(
      new Request(`https://pool.example${path}`, {
        method,
        headers: {
          Authorization: `Bearer private-model-request-key-${path === "/messages" ? 74 : 73}`,
        },
        ...(method === "POST" ? { body: requestBody } : {}),
      }),
    );
  await worker.alarm();
  assert.deepEqual(homeReads, [73, 74, 75]);
  assert.equal((await modelRequest("/v1/responses")).status, 200);
  await drain();
  assert.deepEqual(
    trackedEvents().map((event) => [event.event, event.distinct_id]),
    [["first_model_request", "response-owner"]],
  );
  assert.deepEqual(homeReads, [73, 74, 75, 73], "legacy success bypasses only its exact key cache");

  const readsBeforeFailure = homeReads.length;
  assert.equal((await modelRequest("/chat/completions")).status, 502);
  assert.equal((await modelRequest("/v1/models", "GET")).status, 200);
  await drain();
  assert.equal(homeReads.length, readsBeforeFailure);
  assert.equal(trackedEvents().length, 1);

  assert.equal((await modelRequest("/messages")).status, 200);
  await drain();
  assert.equal(trackedEvents().length, 1);
  assert.deepEqual(homeReads, [73, 74, 75, 73, 74]);
  homeUsage.add(74); // Home persists the streamed success after the response headers.
  await worker.alarm();
  assert.equal(trackedEvents().length, 1, "negative observations wait for their own deadline");
  t.mock.timers.tick(5 * 60_000);
  await worker.alarm();
  await drain();
  assert.equal(publications, 2);
  assert.deepEqual(
    trackedEvents().map((event) => [event.event, event.distinct_id]),
    [
      ["first_model_request", "response-owner"],
      ["first_model_request", "delayed-owner"],
    ],
  );
  const telemetry = analyticsBodies.join("\n");
  assert.equal(telemetry.includes(requestBody), false);
  assert.equal(telemetry.includes("private-model-request-key"), false);
});
