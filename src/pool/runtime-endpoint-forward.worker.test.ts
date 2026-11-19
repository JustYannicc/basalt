import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { historyMemoryOwnerFixture } from "../../scripts/pool-tests/history-fixture.ts";
import { slotIdentity } from "../../scripts/pool-tests/runtime-slots-fixture.ts";
import { digest } from "./backend-users.ts";
import { readPoolReliability } from "./model-history/reliability.ts";
import { migrateModelHistory, type HistoryDatabase } from "./model-history/schema.ts";
import { recordTerminalFinish, recordTerminalStart } from "./model-history/terminal.ts";
import { NativeStreams } from "./native-streams.ts";
import { refuseRuntime } from "./runtime-route-diagnostic.ts";
import { BoundSlotDriver } from "./runtime-slots/transport.ts";

for (const failure of ["throw", "refusal"] as const)
  test(`production forwarding joins the endpoint failure ID: ${failure}`, async (context) => {
    const log = context.mock.method(console, "error", () => {});
    const workerModule = "./forward.worker.ts";
    const {
      forwardPoolRequest,
    }: {
      forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
    } = await import(workerModule);
    const driver = new BoundSlotDriver(() => ({
      fetch: async () => {
        if (failure === "throw") throw new Error("private-endpoint-error");
        return new Response("private-refusal-body", {
          status: 409,
          headers: {
            "X-Signalbox-Runtime-Failure-Step": "endpoint_health",
            "X-Signalbox-Runtime-Failure-Reason": "transport",
          },
        });
      },
    }));
    const background: Promise<unknown>[] = [];
    const response = await forwardPoolRequest(new Request("http://pool/v1/models"), 8317, {
      env: { POOL_APP_SIGNING_KEY: "synthetic" },
      memberships: { configured: async () => false },
      streams: { active: 0 },
      route: async () => {
        try {
          await driver.health(slotIdentity("primary"), AbortSignal.timeout(2000));
        } catch (error) {
          refuseRuntime("slot_health", error);
        }
        throw new Error("expected health refusal");
      },
      defer: (work: Promise<unknown>) => background.push(work),
    });
    assert.equal(response.status, 503);
    const endpoint = JSON.parse(
      log.mock.calls.find((call) => call.arguments[0] === "POOL_RUNTIME_ENDPOINT_FAILURE")!
        .arguments[1],
    );
    const gateway = log.mock.calls.find((call) => call.arguments[0] === "POOL_GATEWAY_FAILURE")!
      .arguments[1];
    assert.equal(response.headers.get("X-Request-Id"), endpoint.requestId);
    assert.equal(gateway.requestId, endpoint.requestId);
    assert.doesNotMatch(JSON.stringify(log.mock.calls.map((call) => call.arguments)), /private-/);
    await response.body?.cancel();
    await Promise.all(background);
  });

test("a retried request refused at the runtime endpoint counts once in reliability", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const database = new PGlite();
  Reflect.set(globalThis, "__endpointRefusalDb", database);
  const hooks = registerHooks({
    resolve(specifier, hookContext, next) {
      if (specifier === "pg")
        return {
          url:
            "data:text/javascript," +
            encodeURIComponent(`export default {Client: class {
        connection = {stream: {destroy() {}}}; on() {} async connect() {} async end() {}
        query(text, values) { return globalThis.__endpointRefusalDb.query(text, values); }
      }}`),
          shortCircuit: true,
        };
      return next(specifier, hookContext);
    },
  });
  context.after(async () => {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__endpointRefusalDb");
    await database.close();
  });
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  await historyMemoryOwnerFixture(db);
  await migrateModelHistory(db);
  await db.query(
    `INSERT INTO basalt_model_history_cursor
    (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id)
    VALUES ($1,0,0,0,true,0)`,
    [await digest("home-local-v1")],
  );
  const workerModule = "./forward.worker.ts";
  const {
    forwardPoolRequest,
  }: {
    forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
  } = await import(workerModule);
  const driver = new BoundSlotDriver(() => ({
    fetch: async () => {
      throw new TypeError("network connection lost");
    },
  }));
  let attemptId = "";
  const background: Promise<unknown>[] = [];
  const response = await forwardPoolRequest(
    new Request("https://pool.example/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-sol", input: "fixture prompt" }),
    }),
    8317,
    {
      env: {
        POOL_APP_SIGNING_KEY: "ab".repeat(32),
        POOL_MODEL_HISTORY_ENABLED: "true",
        POOL_AUTH_DATABASE: { connectionString: "postgres://fixture" },
      },
      appModel: { pool: "fixture", person: "fixture-person" },
      memberships: { configured: async () => true, authority: async () => undefined },
      streams: new NativeStreams(),
      route: async (outbound: Request) => {
        attemptId = outbound.headers.get("X-Basalt-Request-Id") ?? "";
        try {
          await driver.health(slotIdentity("primary"), AbortSignal.timeout(2000));
        } catch (error) {
          refuseRuntime("slot_health", error);
        }
        throw new Error("expected health refusal");
      },
      defer: (work: Promise<unknown>) => background.push(work),
    },
  );
  for (let index = 0; index < background.length; index++) await background[index];
  assert.equal(response.status, 503);
  assert.ok(attemptId);
  // An earlier attempt of this request waited on a busy pool and shares its identity. Its terminal
  // start and failed finish are what the retry's refusal must be deduplicated against.
  const at = new Date().toISOString();
  await recordTerminalStart(db, {
    requestId: attemptId,
    pool: "fixture",
    person: await digest("fixture-person"),
    pathname: "/v1/responses",
    at,
  });
  await recordTerminalFinish(db, attemptId, {
    outcome: "provider_failed",
    status: 503,
    bytes: 0,
    at,
  });
  const reliability = await readPoolReliability(
    db,
    "fixture",
    new Date(Date.now() - 3_600_000).toISOString(),
    new Date(Date.now() + 3_600_000).toISOString(),
  );
  assert.equal(reliability.real.requests, 1);
  assert.equal(reliability.real.failed, 1);
  const rows = (await db.query("SELECT request_id FROM basalt_model_requests")).rows;
  assert.deepEqual(rows, [{ request_id: attemptId }]);
  const endpoint = JSON.parse(
    log.mock.calls.find((call) => call.arguments[0] === "POOL_RUNTIME_ENDPOINT_FAILURE")!
      .arguments[1],
  );
  const gateway = log.mock.calls.find((call) => call.arguments[0] === "POOL_GATEWAY_FAILURE")!
    .arguments[1];
  assert.notEqual(endpoint.requestId, attemptId);
  assert.equal(response.headers.get("X-Request-Id"), endpoint.requestId);
  assert.equal(gateway.requestId, endpoint.requestId);
  assert.equal(gateway.attemptRequestId, attemptId);
  await response.body?.cancel();
});
