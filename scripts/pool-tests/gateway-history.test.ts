import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { NativeMemberships } from "../../src/pool/membership.ts";
import { NativeStreams } from "../../src/pool/native-streams.ts";
import { PoolLifecycle } from "../../src/pool/lifecycle.ts";
import { RuntimeProtection } from "../../src/pool/runtime-protection.ts";
import { summarySelection, summaryDailyQuery } from "../../src/pool/model-history/summary-query.ts";
import { summaryGroups } from "../../src/pool/model-history/summary-values.ts";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import { recordGatewayRefusal } from "../../src/pool/model-history/gateway.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { historyMemoryOwnerFixture } from "./history-fixture.ts";

test("a gateway refusal appears once in activated history with no fabricated usage or charge", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    await historyMemoryOwnerFixture(db);
    await migrateModelHistory(db);
    const input = {
      requestId: crypto.randomUUID(),
      at: "2026-10-31T12:00:00.000Z",
      pool: "pool-a",
      person: await digest("person"),
      keyId: 1,
      pathname: "/v1/responses",
      latencyMs: 4.6,
    };
    await recordGatewayRefusal(db, input);
    assert.equal((await db.query("SELECT * FROM basalt_model_requests")).rows.length, 0);
    await db.query(
      `INSERT INTO basalt_model_history_cursor (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id)
      VALUES ($1,0,0,0,true,0)`,
      ["a".repeat(64)],
    );
    await recordGatewayRefusal(db, input);
    await recordGatewayRefusal(db, input);
    const rows = (await db.query("SELECT * FROM basalt_model_requests")).rows;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.pool, (await digest("pool-a")).slice(0, 16));
    assert.equal(row.person, input.person);
    assert.equal(row.request_id, input.requestId);
    assert.equal(row.status_code, 503);
    assert.equal(row.failed, true);
    assert.equal(row.api_type, "pool-protection-unavailable");
    for (const field of [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "cost",
      "currency",
      "model",
      "provider",
    ])
      assert.equal(row[field], null, field);
  } finally {
    await database.close();
  }
});

for (const [model, provider] of [
  ["claude-opus-5-5", "claude"],
  ["gpt-6.1-sol", "codex"],
  ["grok-4.7", "xai"],
  ["unlisted-alias", null],
])
  test(`a pre-dispatch refusal retains requested model ${model} without inventing usage`, async () => {
    const database = new PGlite();
    const db: HistoryDatabase = {
      query: async (text, values) => {
        const result = await database.query<Record<string, unknown>>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    };
    try {
      await historyMemoryOwnerFixture(db);
      await migrateModelHistory(db);
      await db.query(
        `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id)
      VALUES ($1,0,0,0,true,0)`,
        ["a".repeat(64)],
      );
      const input = {
        requestId: crypto.randomUUID(),
        at: "2026-11-11T10:00:00Z",
        pool: "pool-a",
        person: null,
        pathname: "/v1/responses",
        latencyMs: 5,
        requestedModel: model,
      };
      await recordGatewayRefusal(db, input);
      const row = (await db.query("SELECT * FROM basalt_model_requests")).rows[0]!;
      assert.equal(row.model, model);
      assert.equal(row.provider, provider);
      assert.equal(row.failed, true);
      assert.equal(row.input_tokens, null);
      assert.equal(row.total_tokens, null);
      assert.equal(row.cost, null);
    } finally {
      await database.close();
    }
  });

test("forwarded request metadata survives a pre-dispatch failure through storage and the overview aggregate", async (t) => {
  const database = new PGlite();
  Reflect.set(globalThis, "__gatewayRefusalDb", database);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "pg")
        return {
          url:
            "data:text/javascript," +
            encodeURIComponent(`export default {Client: class {
        connection = {stream: {destroy() {}}}; on() {} async connect() {} async end() {}
        query(text, values) { return globalThis.__gatewayRefusalDb.query(text, values); }
      }}`),
          shortCircuit: true,
        };
      return next(specifier, context);
    },
  });
  t.after(async () => {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__gatewayRefusalDb");
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
    ["a".repeat(64)],
  );
  const never = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  const storage = {
    get: async <T>(): Promise<T | undefined> => undefined,
    put: never,
    getAlarm: never,
    setAlarm: never,
  };
  const memberships = new NativeMemberships({
    storage,
    signingKey: "ab".repeat(32),
    read: never,
    actual: never,
    reconcile: never,
    install: never,
    abort: () => {},
    schedule: never,
  });
  t.mock.method(memberships, "configured", async () => true);
  t.mock.method(memberships, "authority", async () => undefined);
  t.mock.method(console, "error", () => {});
  const streams = new NativeStreams();
  const background: Promise<unknown>[] = [];
  const deps = {
    env: {
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      POOL_MODEL_HISTORY_ENABLED: "true",
      POOL_AUTH_DATABASE: { connectionString: "postgres://fixture" },
    },
    appModel: { pool: "pool-a", person: "fixture-person" },
    computers: { nativeModel: never, observeUsage: never },
    memberships,
    streams,
    lifecycle: Promise.resolve(
      new PoolLifecycle(
        { running: () => true, start: never, stop: never, keepAlive: never, status: never },
        storage,
        "fixture",
      ),
    ),
    protection: new RuntimeProtection(streams, {
      check: never,
      defer: () => {},
      unavailable: () => {},
    }),
    route: async () => {
      throw new Error("Synthetic pre-dispatch outage");
    },
    fetch: never,
    defer: (work: Promise<unknown>) => {
      background.push(work);
    },
  };
  const module = "../../src/pool/forward.worker.ts";
  const {
    forwardPoolRequest,
  }: {
    forwardPoolRequest(request: Request, port: 8317, dependencies: typeof deps): Promise<Response>;
  } = await import(module);
  for (const model of ["gpt-6.1-sol", undefined]) {
    const response = await forwardPoolRequest(
      new Request("https://pool.example/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: "private-prompt-sentinel" }),
      }),
      8317,
      deps,
    );
    assert.equal(response.status, 503);
  }
  for (let index = 0; index < background.length; index++) await background[index];
  const rows = (
    await db.query(
      "SELECT provider,model,cost,total_tokens FROM basalt_model_requests ORDER BY model NULLS LAST",
    )
  ).rows;
  assert.deepEqual(rows, [
    { provider: "codex", model: "gpt-6.1-sol", cost: null, total_tokens: null },
    { provider: null, model: null, cost: null, total_tokens: null },
  ]);
  const from = "2020-01-01T00:00:00Z",
    to = "2030-01-01T00:00:00Z";
  const selection = await summarySelection("pool-a", from, to, {
    canManage: true,
    mappingProven: false,
    accounts: [],
  });
  const query = summaryDailyQuery(selection, from, from, false);
  const aggregated = (await db.query(query.text, query.values)).rows.filter(
    (row) => row.scope === "current",
  );
  const result = summaryGroups(
    aggregated,
    { pool: "pool-a", from, to, bucket: "day", by: ["provider"], timezone: "Europe/Zurich" },
    { prices: [], issues: [] },
  );
  const unknown = result.groups.find((group) => group.provider === null)!;
  assert.equal(unknown.buckets[0]?.refusedBeforeLab, 1);
  assert.equal(unknown.buckets[0]?.failed, 1);
  assert.ok(!JSON.stringify(result).includes("private-prompt-sentinel"));
});
