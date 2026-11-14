import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeEndpoint } from "./runtime-slots/endpoint.ts";
import { runtimeRequest } from "./runtime-slots/transport.ts";
import { PoolStartupDeadline, PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";

const env = {
  POOL_DATABASE_URL: "postgresql://fixture:private-password@database.invalid/pool",
  POOL_MANAGEMENT_KEY: "private-management-key",
  POOL_APP_SIGNING_KEY: "ab".repeat(32),
  POOL_DEPLOYMENT_KEY: "e".repeat(64),
  POOL_IMAGE_HASH: "2".repeat(16),
  POOL_RUNTIME_APPLICATION_ID: "runtime-app",
};
const code = { candidate: "a".repeat(40), workerInput: "b".repeat(64) };
const target = {
  format: "pool-runtime-slot-v1" as const,
  controllerId: "controller",
  slotId: "candidate",
  applicationId: "runtime-app",
  applicationVersion: "3",
  instanceId: "runtime-instance",
  imageDigest: `sha256:${"d".repeat(64)}`,
  imageInput: env.POOL_IMAGE_HASH,
};
function endpoint(error: unknown) {
  let reads = 0;
  const ctx = {
    id: { toString: () => target.instanceId },
    storage: {
      get: async <T>(): Promise<T | undefined> => {
        reads++;
        throw error;
      },
      put: async () => {},
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    waitUntil: () => {},
    container: {
      running: false,
      start: () => {},
      destroy: async () => {},
      setInactivityTimeout: async () => {},
      getTcpPort: () => ({ fetch: async () => new Response() }),
    },
  };
  return { value: new RuntimeEndpoint(ctx, env, "runtime", code), reads: () => reads };
}
function request(body = JSON.stringify({ target, privateBody: "PRIVATE_REQUEST_BODY" })) {
  return new Request("http://runtime/start?token=PRIVATE_QUERY", {
    method: "POST",
    headers: { Authorization: "Bearer PRIVATE_HEADER" },
    body,
  });
}

for (const error of [
  new TypeError("Connection lost in runtime storage"),
  new PoolStartupDeadline(),
  new PoolRuntimeUnhealthy(),
  new SlotRefused("identity"),
])
  test(`endpoint refusal records its actual cause without changing the public response: ${error.constructor.name}`, async (context) => {
    const log = context.mock.method(console, "error", () => {});
    const f = endpoint(error);
    const before = { name: error.name, message: error.message, stack: error.stack };
    const response = await runtimeRequest(request(), f.value);
    assert.equal(response.status, 409);
    assert.deepEqual([...response.headers], [["content-type", "application/json"]]);
    assert.deepEqual(await response.json(), { error: "runtime-refused" });
    assert.equal(f.reads(), 1);
    assert.equal(log.mock.calls.length, 1, "the dropped cause must be recorded");
    const [event, diagnostic] = log.mock.calls[0]!.arguments;
    assert.equal(event, "POOL_RUNTIME_ENDPOINT_FAILURE");
    assert.ok(diagnostic && typeof diagnostic === "object");
    assert.deepEqual(diagnostic, {
      hop: "endpoint_route",
      operation: "start",
      status: 409,
      runtime: {
        role: "runtime",
        instanceId: target.instanceId,
        applicationId: env.POOL_RUNTIME_APPLICATION_ID,
        ...code,
      },
      exception: {
        class: error.constructor.name,
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
    assert.deepEqual({ name: error.name, message: error.message, stack: error.stack }, before);
    assert.ok(!JSON.stringify(diagnostic).includes("PRIVATE_"));
  });

test("endpoint cause removes configured and labelled credentials before logging", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const secrets = [
    env.POOL_DATABASE_URL,
    env.POOL_MANAGEMENT_KEY,
    env.POOL_APP_SIGNING_KEY,
    env.POOL_DEPLOYMENT_KEY,
    "unconfigured-token-value",
    "private-cookie-value",
  ];
  const error = new Error(
    `Storage refused ${secrets.slice(0, 4).join(" ")} Bearer ${secrets[4]} cookie=${secrets[5]}`,
  );
  const f = endpoint(error);
  await runtimeRequest(request(), f.value);
  const serialized = JSON.stringify(log.mock.calls[0]?.arguments);
  assert.ok(serialized.includes("Storage refused"));
  for (const secret of [...secrets, "PRIVATE_REQUEST_BODY", "PRIVATE_HEADER", "PRIVATE_QUERY"])
    assert.ok(!serialized.includes(secret), "credential or request content leaked");
  assert.ok(
    error.message.includes(env.POOL_MANAGEMENT_KEY),
    "logging must not mutate the exception",
  );
});

test("invalid request diagnostics never include JSON input excerpts or unknown operation text", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const f = endpoint(new Error("unused"));
  await runtimeRequest(request("PRIVATE_REQUEST_BODY is not JSON"), f.value);
  const serialized = JSON.stringify(log.mock.calls[0]?.arguments);
  assert.equal(log.mock.calls.length, 1);
  assert.ok(serialized.includes("SyntaxError"));
  assert.ok(!serialized.includes("PRIVATE_REQUEST_BODY"));
  assert.equal(f.reads(), 0);
});

test("schema failure diagnostics omit multiline input excerpts", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const f = endpoint(new Error("unused"));
  await runtimeRequest(
    request(
      JSON.stringify({ target: { ...target, instanceId: { privateBody: "PRIVATE_SCHEMA_BODY" } } }),
    ),
    f.value,
  );
  const serialized = JSON.stringify(log.mock.calls[0]?.arguments);
  assert.equal(log.mock.calls.length, 1);
  assert.ok(serialized.includes("SchemaError"));
  assert.ok(!serialized.includes("PRIVATE_SCHEMA_BODY"));
  assert.equal(f.reads(), 0);
});

test("non-Error throws are identified without serializing their content", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const failure = { message: "PRIVATE_THROWN_CONTENT", body: "PRIVATE_REQUEST_BODY" };
  const f = endpoint(failure);
  const response = await runtimeRequest(request(), f.value);
  assert.equal(response.status, 409);
  assert.equal(log.mock.calls.length, 1);
  const serialized = JSON.stringify(log.mock.calls[0]!.arguments);
  assert.ok(serialized.includes("NonError"));
  assert.ok(!serialized.includes("PRIVATE_"));
});
