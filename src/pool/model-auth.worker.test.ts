import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { accessPath } from "./access-contract.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return {
      url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      shortCircuit: true,
    };
    if (specifier === "pg") return {
      url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query(_text, values) { return { rows: [{ active: Array.isArray(values?.[0]) && values[0].includes('valid-home-key') }] }; } async end() {} } }",
      shortCircuit: true,
    };
    return next(specifier, context);
  },
});
const { handlePoolWorkerRequest } = await import("./worker.ts");
hooks.deregister();

type WorkerEnvironment = Parameters<typeof handlePoolWorkerRequest>[1];

function poolStub() {
  const calls = { lookups: 0, forwarded: [] as Request[] };
  const env = {
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/basalt_pool",
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
                return new Response("forwarded", { status: 202 });
              },
            };
          },
        };
      },
    },
  } as unknown as WorkerEnvironment;
  return { env, calls };
}

test("missing model keys return 401 before the Worker obtains the pool Durable Object", async () => {
  const { env, calls } = poolStub();
  let keyLookups = 0;
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/models"),
    env,
    async () => { keyLookups += 1; return false; },
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
    async (_connectionString, candidates) => { checked = candidates; return false; },
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
    async () => { throw new Error("database unavailable"); },
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
  const response = await handlePoolWorkerRequest(request, env, async (connectionString, candidates) => {
    assert.equal(connectionString, env.POOL_DATABASE_URL);
    checked = candidates;
    return candidates.includes("valid-home-key");
  });

  assert.equal(response.status, 202);
  assert.deepEqual(checked, ["wrong-bearer-key", "valid-home-key", "wrong-query-key"]);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.forwarded.length, 1);
  assert.equal(calls.forwarded[0], request);
});

test("valid legacy Home key transports continue to the pool Durable Object", async () => {
  const requests = [
    new Request("https://pool.example/v1/models", { headers: { Authorization: "bEaReR home-key" } }),
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

test("a whitespace-padded query key cannot wake the container using an active key's value", async () => {
  const { env, calls } = poolStub();
  const response = await handlePoolWorkerRequest(
    new Request("https://pool.example/v1/models?key=%20valid-home-key%20"),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal(calls.lookups, 0);
  assert.equal(calls.forwarded.length, 0);
});

test("signed pool access remains outside the Home model-key gate", async () => {
  const { env, calls } = poolStub();
  let keyLookups = 0;
  const response = await handlePoolWorkerRequest(
    new Request(`https://pool.example${accessPath}`, { method: "POST", body: "signed access envelope" }),
    env,
    async () => { keyLookups += 1; throw new Error("model-key lookup should not run"); },
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
    new Request("https://pool.example/__setup/v1/computers/access", { method: "POST", body: "signed setup action" }),
    env,
    async () => { keyLookups += 1; throw new Error("model-key lookup should not run"); },
  );

  assert.equal(response.status, 202);
  assert.equal(keyLookups, 0);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.forwarded.length, 1);
});
