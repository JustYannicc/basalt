import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { accessPath } from "./access-contract.ts";
import type { HomeApiKeyLookup } from "./model-auth.ts";
import { poolReceiveHeader } from "./pool-arrival.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: `data:text/javascript,${encodeURIComponent(`
        export default { Client: class {
          constructor(options) { this.unavailable = options.connectionString === 'postgres://unavailable'; }
          on() {}
          connection = { stream: { destroy() {} } };
          async connect() { if (this.unavailable) throw new Error('database unavailable'); }
          async query(_text, values) {
            if (!values) return { rows: [] };
            if (values[0].includes(String.fromCharCode(0))) throw new Error('invalid text encoding');
            return { rows: [{ active: values[0] === 'valid-home-key' }] };
          }
          async end() {}
        } };
      `)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
// Keep Workers platform types in tsconfig.worker.json, like model-usage.worker.test.ts.
const workerModule = "./worker.ts";
const {
  default: worker,
  handlePoolWorkerRequest,
}: {
  default: { fetch(request: Request, env: object): Promise<Response> };
  handlePoolWorkerRequest(
    request: Request,
    env: object,
    lookupHomeApiKey?: HomeApiKeyLookup,
    defer?: (work: Promise<unknown>) => void,
  ): Promise<Response>;
} = await import(workerModule);
hooks.deregister();

/** Everything a caller sent arrives as sent; the Worker adds only its own receive times. */
function assertForwarded(forwarded: Request, sent: Request) {
  assert.equal(forwarded.method, sent.method);
  assert.equal(forwarded.url, sent.url);
  const headers = new Headers(forwarded.headers);
  assert.match(headers.get(poolReceiveHeader) ?? "", /^\d{13},\d{13}$/);
  headers.delete(poolReceiveHeader);
  assert.deepEqual([...headers], [...sent.headers]);
}

function poolStub(
  connectionString = "postgres://fixture:fixture@hyperdrive.invalid/basalt_pool",
  respond = async (_request: Request) => new Response("forwarded", { status: 202 }),
) {
  const calls = { lookups: 0, forwarded: [] as Request[] };
  const env = {
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/basalt_pool",
    POOL_AUTH_DATABASE: { connectionString },
    PoolContainer: {
      jurisdiction(region: string) {
        calls.lookups += 1;
        assert.equal(region, "eu");
        return {
          getByName(name: string) {
            assert.equal(name, "control-plane");
            return {
              fetch: async (request: Request) => {
                calls.forwarded.push(request);
                return respond(request);
              },
            };
          },
        };
      },
    },
  };
  return { env, calls };
}

test("the exported Worker rejects bad credentials before controller lookup and preserves valid requests", async () => {
  const cases: { request: Request; status: number; unavailable?: boolean }[] = [
    { request: new Request("https://pool.example/v1/models"), status: 401 },
    { request: new Request("https://pool.example/v1/models?key=invalid-home-key"), status: 401 },
    { request: new Request("https://pool.example/v1/models?key=revoked-home-key"), status: 401 },
    {
      request: new Request("https://pool.example/v1/models?key=%20valid-home-key%20"),
      status: 202,
    },
    {
      request: new Request("https://pool.example/v1/models?key=valid-home-key"),
      status: 503,
      unavailable: true,
    },
    { request: new Request("https://pool.example/v1/models?key=valid-home-key"), status: 202 },
    {
      request: new Request("https://pool.example/v1/models?auth_token=%00", {
        headers: { Authorization: "Bearer valid-home-key" },
      }),
      status: 202,
    },
    {
      request: new Request("https://pool.example/v1/models?key=%00&auth_token=valid-home-key"),
      status: 503,
    },
    {
      request: new Request("https://pool.example/v1/models?auth_token=valid-home-key"),
      status: 202,
    },
    ...["Bearer valid-home-key", "bEaReR valid-home-key", "valid-home-key"].map(
      (Authorization) => ({
        request: new Request("https://pool.example/v1/models", { headers: { Authorization } }),
        status: 202,
      }),
    ),
    ...["X-Goog-Api-Key", "X-Api-Key"].map((header) => ({
      request: new Request("https://pool.example/v1/models", {
        headers: { [header]: "valid-home-key" },
      }),
      status: 202,
    })),
    {
      request: new Request("https://pool.example/v1/chat/completions?key=invalid-home-key", {
        method: "POST",
        body: "unchanged model request",
        headers: { Authorization: "Bearer wrong-key", "X-Api-Key": "valid-home-key" },
      }),
      status: 202,
    },
  ];
  for (const { request, status, unavailable } of cases) {
    const { env, calls } = poolStub(unavailable ? "postgres://unavailable" : undefined);
    const response = await worker.fetch(request, env);
    assert.equal(response.status, status);
    assert.equal(calls.lookups, status === 202 ? 1 : 0);
    assert.equal(calls.forwarded.length, status === 202 ? 1 : 0);
    if (status === 202) {
      assertForwarded(calls.forwarded[0]!, request);
      if (request.method === "POST")
        assert.equal(await calls.forwarded[0]!.text(), "unchanged model request");
    }
  }
});

test("a missing Hyperdrive binding fails closed without using the direct container URL", async () => {
  const { env, calls } = poolStub();
  Reflect.deleteProperty(env, "POOL_AUTH_DATABASE");
  let queries = 0;
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/models?key=valid-home-key"),
    env,
    async () => {
      queries += 1;
      return true;
    },
  );
  assert.equal(response.status, 503);
  assert.equal(queries, 0);
  assert.equal(calls.lookups, 0);
});

test("missing model keys return 401 before the Worker obtains the pool Durable Object", async () => {
  const { env, calls } = poolStub();
  let keyLookups = 0;
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/models"),
    env,
    async () => {
      keyLookups += 1;
      return false;
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Missing API key" });
  assert.equal(keyLookups, 0);
  assert.equal(calls.lookups, 0);
  assert.equal(calls.forwarded.length, 0);
});

test("invalid and revoked model keys return 401 without a Durable Object lookup", async () => {
  const { env, calls } = poolStub();
  let checked: readonly string[] = [];
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/responses?key=revoked-home-key"),
    env,
    async (_connectionString, candidates) => {
      checked = candidates;
      return false;
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid API key" });
  assert.deepEqual(checked, ["revoked-home-key"]);
  assert.equal(calls.lookups, 0);
  assert.equal(calls.forwarded.length, 0);
});

test("pool database failures return 503 without a Durable Object lookup", async () => {
  const { env, calls } = poolStub();
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer some-home-key" },
      body: "{}",
    }),
    env,
    async () => {
      throw new Error("database unavailable");
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Authentication service unavailable" });
  assert.equal(calls.lookups, 0);
  assert.equal(calls.forwarded.length, 0);
});

test("any matching candidate continues unchanged through the pool Durable Object", async () => {
  const { env, calls } = poolStub();
  const request = new Request("https://pool.example/v1/chat/completions?key=wrong-query-key", {
    method: "POST",
    headers: {
      Authorization: "Bearer wrong-bearer-key",
      "X-Api-Key": "valid-home-key",
    },
    body: "model request",
  });
  let checked: readonly string[] = [];
  const response = await handlePoolWorkerRequest(
    request,
    env,
    async (connectionString, candidates) => {
      assert.equal(connectionString, env.POOL_AUTH_DATABASE!.connectionString);
      checked = candidates;
      return candidates.includes("valid-home-key");
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(checked, ["wrong-bearer-key", "valid-home-key", "wrong-query-key"]);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.forwarded.length, 1);
  assertForwarded(calls.forwarded[0]!, request);
  assert.equal(await calls.forwarded[0]!.text(), "model request");
});

test("valid legacy Home key transports continue to the pool Durable Object", async () => {
  const requests = [
    new Request("https://pool.example/v1/models", {
      headers: { Authorization: "bEaReR home-key" },
    }),
    new Request("https://pool.example/v1/models", { headers: { Authorization: "home-key" } }),
    new Request("https://pool.example/v1/models", { headers: { "X-Goog-Api-Key": "home-key" } }),
    new Request("https://pool.example/v1/models", { headers: { "X-Api-Key": "home-key" } }),
    new Request("https://pool.example/v1/models?key=home-key"),
    new Request("https://pool.example/v1/models?auth_token=home-key"),
  ];

  for (const request of requests) {
    const { env, calls } = poolStub();
    const response = await handlePoolWorkerRequest(
      request,
      env,
      async (_connectionString, candidates) => candidates.includes("home-key"),
    );
    assert.equal(response.status, 202);
    assert.equal(calls.lookups, 1);
    assert.equal(calls.forwarded.length, 1);
  }
});

test("the public Worker uses its Home database lookup for valid keys", async () => {
  const { env, calls } = poolStub();
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer valid-home-key" },
      body: "{}",
    }),
    env,
  );

  assert.equal(response.status, 202);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.forwarded.length, 1);
});

test("a whitespace-padded active query key remains valid as in Home", async () => {
  const { env, calls } = poolStub();
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/models?key=%20valid-home-key%20"),
    env,
  );
  assert.equal(response.status, 202);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.forwarded.length, 1);
});

test("signed pool access remains outside the Home model-key gate", async () => {
  const { env, calls } = poolStub();
  let keyLookups = 0;
  const response = await handlePoolWorkerRequest(
    new Request(`https://pool.example${accessPath}`, {
      method: "POST",
      body: "signed access envelope",
    }),
    env,
    async () => {
      keyLookups += 1;
      throw new Error("model-key lookup should not run");
    },
  );

  assert.equal(response.status, 202);
  assert.equal(keyLookups, 0);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.forwarded.length, 1);
});

test("computer setup credentials remain outside the Home model-key gate", async () => {
  const { env, calls } = poolStub();
  let keyLookups = 0;
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/__setup/v1/computers/access", {
      method: "POST",
      body: "signed setup action",
    }),
    env,
    async () => {
      keyLookups += 1;
      throw new Error("model-key lookup should not run");
    },
  );

  assert.equal(response.status, 202);
  assert.equal(keyLookups, 0);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.forwarded.length, 1);
});

test("private model lifetime routes never read production auth or wake a controller", async () => {
  const { env, calls } = poolStub();
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/__basalt/model-lifetime", {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer valid-home-key",
        "Sec-WebSocket-Protocol": "basalt.model-lifetime.v1",
        "x-basalt-model-lifetime-id": "f".repeat(32),
      },
    }),
    env,
    async () => {
      throw new Error("Private route reached auth lookup");
    },
  );
  assert.equal(response.status, 404);
  assert.equal(calls.lookups, 0);
});

test("raw ingress strips private lifetime headers and offer while preserving public subprotocol bytes", async () => {
  const { env, calls } = poolStub();
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/responses", {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer valid-home-key",
        "Sec-WebSocket-Protocol": "raw.one, raw.two, basalt.model-lifetime.v1",
        "x-basalt-model-lifetime-id": "f".repeat(32),
      },
    }),
    env,
    async () => true,
  );
  assert.equal(response.status, 202);
  assert.equal(calls.forwarded.length, 1);
  assert.equal(calls.forwarded[0]!.headers.get("x-basalt-model-lifetime-id"), null);
  assert.equal(calls.forwarded[0]!.headers.get("Sec-WebSocket-Protocol"), "raw.one, raw.two");
});

/** Pool request events the Worker itself writes; the object a stub stands in for writes none. */
function workerEvents(context: TestContext) {
  const events: Record<string, unknown>[] = [];
  context.mock.method(console, "info", (value: unknown) => {
    if (typeof value === "object" && value !== null && "outcome" in value)
      events.push({ ...value });
  });
  return events;
}

const instanceEnded =
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";

test("a controller reset at the Worker entry is survived by one send to a new instance", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const events = workerEvents(context);
  let sends = 0;
  const { env, calls } = poolStub(undefined, async (request) => {
    if (++sends === 1) throw new Error(instanceEnded);
    return new Response(await request.text(), { status: 200 });
  });
  const deferred: Promise<unknown>[] = [];
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/messages", {
      method: "POST",
      headers: { "X-Api-Key": "valid-home-key" },
      body: '{"model":"claude-opus-5-5"}',
    }),
    env,
    async () => true,
    (work) => deferred.push(work),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"model":"claude-opus-5-5"}');
  assert.equal(calls.lookups, 2);
  assert.equal(calls.forwarded.length, 2);
  await Promise.all(deferred);
  const saved = log.mock.calls
    .filter((call) => call.arguments[0] === "POOL_CONTROLLER_INTERRUPTED")
    .map((call) => JSON.parse(String(call.arguments[1])));
  assert.deepEqual(
    saved.map((line) => [line.outcome, line.saved]),
    [["replayed", true]],
  );
  // The new instance answered, so it reports the request, with the first call to time the replay.
  assert.deepEqual(events, []);
  const [first, second] = calls.forwarded.map((forwarded) =>
    forwarded.headers.get(poolReceiveHeader)!.split(","),
  );
  assert.equal(first!.length, 2);
  assert.deepEqual([second![0], second![2]], first);
});

test("a reset the Worker answers itself is reported once, by the Worker", async (context) => {
  context.mock.method(console, "error", () => {});
  const events = workerEvents(context);
  for (const [path, status, sends] of [
    ["/v1/messages", 503, 2],
    ["/v1/videos", 502, 1],
  ] as const) {
    events.length = 0;
    const { env, calls } = poolStub(undefined, async () => {
      throw new Error(instanceEnded);
    });
    const deferred: Promise<unknown>[] = [];
    const response = await handlePoolWorkerRequest(
      new Request(`https://pool.example${path}`, {
        method: "POST",
        headers: { "X-Api-Key": "valid-home-key" },
        body: '{"model":"claude-opus-5-5"}',
      }),
      env,
      async () => true,
      (work) => deferred.push(work),
    );
    assert.equal(response.status, status, path);
    assert.equal(calls.forwarded.length, sends, path);
    await Promise.all(deferred);
    assert.equal(events.length, 1, path);
    const event = events[0]!;
    assert.equal(event.outcome, "controller_reset", path);
    assert.equal(event.status, status, path);
    assert.equal(event.requestId, response.headers.get("X-Request-Id"), path);
    assert.equal(typeof event.unansweredMs, "number", path);
    assert.equal(event.queueMs, undefined, path);
    // Only the call sent twice spent time between its attempts.
    if (sends === 2) assert.ok(Number(event.replayMs) >= 1_000, path);
    else assert.equal(event.replayMs, undefined, path);
  }
});

test("a caller who leaves while a reset call waits to be sent again is not a controller failure", async (context) => {
  let callFailed!: () => void;
  const failed = new Promise<"failed">((resolve) => (callFailed = () => resolve("failed")));
  const log = context.mock.method(console, "error", (name: unknown) => {
    if (name === "POOL_CONTROLLER_CALL_FAILED") callFailed();
  });
  const events = workerEvents(context);
  const { env, calls } = poolStub(undefined, async () => {
    throw new Error(instanceEnded);
  });
  const caller = new AbortController();
  const deferred: Promise<unknown>[] = [];
  const answer = handlePoolWorkerRequest(
    new Request("https://pool.example/v1/messages", {
      method: "POST",
      headers: { "X-Api-Key": "valid-home-key" },
      body: '{"model":"claude-opus-5-5"}',
      signal: caller.signal,
    }),
    env,
    async () => true,
    (work) => deferred.push(work),
  ).catch((error: unknown) => error);
  // The first call has failed once the hop says so, and not because the request already ended.
  assert.equal(await Promise.race([failed, answer.then(() => "settled" as const)]), "failed");
  // Let the hop reach its wait before the caller leaves.
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();
  await answer;
  await Promise.all(deferred);
  assert.equal(calls.forwarded.length, 1);
  const [line] = log.mock.calls
    .filter((call) => call.arguments[0] === "POOL_CONTROLLER_INTERRUPTED")
    .map((call) => JSON.parse(String(call.arguments[1])));
  assert.equal(line?.outcome, "client_left");
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.outcome, "client_closed");
  assert.equal(typeof event.unansweredMs, "number");
  assert.equal(event.queueMs, undefined);
  // The event and the hop's log line name the same request.
  assert.equal(event.requestId, line.requestId);
});
