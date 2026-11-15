import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { connectHistoryPlatform, runHistoryOperator } from "../pool-history-operator.ts";
import { HistoryOperatorFailure } from "../pool-history-operator-failure.ts";
import { historyMemoryOwnerFixture, homeMetadataFixture } from "../pool-tests/history-fixture.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  historyJournalActivationPath,
  modelHistorySchemaPlan,
} from "../../src/pool/model-history/operator.ts";
import { historyPlan } from "./migration-activation-commands.ts";
import { BarrierRefusal } from "./refusal.ts";
import { refusalTable } from "./refusal-report.ts";

test("activation accepts the real prepared operator plan and reports exact dry-run failures", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  const privateDiagnostic = "private-transport-secret@fixture.invalid";
  let writes = 0;
  try {
    await historyMemoryOwnerFixture(db);
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    for (const scenario of [
      { name: "valid", field: "" },
      { name: "connect", field: "operator.connect" },
      { name: "http", field: "operator.response.status" },
      { name: "decode", field: "operator.response.json" },
      { name: "version", field: "report.version" },
      { name: "schema", field: "report.schemaHash" },
      { name: "catalog", field: "report.catalogHash" },
      { name: "reader", field: "report.readersReadyRequired" },
      { name: "catalog-shape", field: "report.catalog" },
      { name: "diff-shape", field: "report.catalogDiff" },
      { name: "relation-row", field: "report.catalog.relations" },
    ]) {
      const connect = async () => {
        if (scenario.name === "connect")
          throw Object.assign(new Error(privateDiagnostic), {
            _tag: "CloudflareError",
            status: 403,
            code: 10000,
          });
        return {
          env: {
            POOL_OPERATIONS: {
              fetch: async (request: Request) => {
                if (request.method !== "GET") writes++;
                assert.equal(request.method, "GET");
                assert.equal(new URL(request.url).pathname, historyJournalActivationPath);
                if (scenario.name === "http")
                  return new Response(privateDiagnostic, { status: 503 });
                if (scenario.name === "decode") return new Response(privateDiagnostic);
                const report = await modelHistorySchemaPlan(db, "journal-activation");
                const catalog =
                  scenario.name === "relation-row"
                    ? { ...report.catalog, relations: [...report.catalog.relations, null] }
                    : report.catalog;
                return Response.json({
                  status: "dry-run",
                  ...report,
                  catalog,
                  catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
                  ...(scenario.name === "version" ? { version: privateDiagnostic } : {}),
                  ...(scenario.name === "schema" ? { schemaHash: "a".repeat(64) } : {}),
                  ...(scenario.name === "catalog" ? { catalogHash: "b".repeat(64) } : {}),
                  ...(scenario.name === "reader"
                    ? { readersReadyRequired: privateDiagnostic }
                    : {}),
                  ...(scenario.name === "catalog-shape" ? { catalog: null } : {}),
                  ...(scenario.name === "diff-shape" ? { catalogDiff: null } : {}),
                });
              },
            },
          },
          dispose: async () => {},
        };
      };
      const plan = () =>
        historyPlan(
          (options, account) =>
            runHistoryOperator(
              { ...options, readersReady: options.readersReady },
              account,
              connect,
            ),
          "a".repeat(32),
          "fixture-pool",
        );
      if (scenario.name === "valid") {
        const result = await plan();
        assert.equal(result.prepared, true);
        assert.equal(result.active, false);
        assert.equal(result.report.version, "model_request_history_v10_change_journal_activate");
        continue;
      }
      await assert.rejects(plan, (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.equal(error.reason, "migration-activation-pool-plan");
        assert.equal(error.worker, "PoolWorker");
        assert.deepEqual(
          error.delta?.changed,
          scenario.name === "http"
            ? [{ path: scenario.field, old: 200, new: 503 }]
            : [{ path: scenario.field, changed: true }],
          scenario.name,
        );
        const publicFailure = JSON.stringify(error) + refusalTable(error);
        if (scenario.name === "connect")
          assert.deepEqual(error.delta?.why, [
            "phase=proxy-open",
            `runtime=${process.versions.bun ? "bun" : "node"}`,
            "type=CloudflareError",
            "status=403",
            "codes=10000",
          ]);
        assert.ok(publicFailure.includes(scenario.field));
        assert.ok(!publicFailure.includes(privateDiagnostic));
        return true;
      });
    }
    assert.equal(writes, 0);
    assert.equal((await modelHistorySchemaPlan(db, "journal-activation")).applied, false);
  } finally {
    await database.close();
  }
});

test("a plain connection Error retains its safe nested Wrangler cause without private text", async () => {
  const sentinel = "private-operator-message@fixture.invalid";
  const cause = Object.assign(new Error(sentinel), {
    name: "APIError",
    status: 403,
    code: 10000,
    url: sentinel,
    body: sentinel,
  });
  await assert.rejects(
    historyPlan(
      async () => {
        throw new HistoryOperatorFailure(
          "operator.connect",
          undefined,
          new Error(sentinel, { cause }),
        );
      },
      "a".repeat(32),
      "fixture-pool",
    ),
    (error: unknown) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.equal(error.reason, "migration-activation-pool-plan");
      assert.deepEqual(error.delta?.why, [
        "phase=proxy-open",
        `runtime=${process.versions.bun ? "bun" : "node"}`,
        "type=Error",
        "cause.1.type=APIError",
        "cause.1.status=403",
        "cause.1.codes=10000",
      ]);
      assert.ok(!(JSON.stringify(error) + refusalTable(error)).includes(sentinel));
      return true;
    },
  );
});

test("module loading and remote proxy initialization have distinct closed failure stages", async () => {
  const sentinel = "private-module-or-proxy-message@fixture.invalid";
  for (const loading of [true, false]) {
    await assert.rejects(
      historyPlan(
        (options, account) =>
          runHistoryOperator({ ...options, readersReady: options.readersReady }, account, (path) =>
            connectHistoryPlatform(path, () => {
              if (loading) throw Object.assign(new Error(sentinel), { code: "MODULE_NOT_FOUND" });
              return {
                getPlatformProxy: async () => {
                  throw new Error(sentinel, {
                    cause: Object.assign(new Error(sentinel), { code: "ECONNRESET" }),
                  });
                },
              };
            }),
          ),
        "a".repeat(32),
        "fixture-pool",
      ),
      (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.deepEqual(error.delta?.changed, [
          { path: loading ? "operator.load-wrangler" : "operator.connect", changed: true },
        ]);
        assert.ok(error.delta?.why?.includes(loading ? "phase=wrangler-load" : "phase=proxy-open"));
        assert.ok(
          error.delta?.why?.includes(loading ? "code=MODULE_NOT_FOUND" : "cause.1.code=ECONNRESET"),
        );
        assert.ok(!(JSON.stringify(error) + refusalTable(error)).includes(sentinel));
        return true;
      },
    );
  }
});
