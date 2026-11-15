import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { runHistoryOperator } from "../pool-history-operator.ts";
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
                return Response.json({
                  status: "dry-run",
                  ...report,
                  ...(scenario.name === "version" ? { version: privateDiagnostic } : {}),
                  ...(scenario.name === "schema" ? { schemaHash: "a".repeat(64) } : {}),
                  ...(scenario.name === "catalog" ? { catalogHash: "b".repeat(64) } : {}),
                  ...(scenario.name === "reader"
                    ? { readersReadyRequired: privateDiagnostic }
                    : {}),
                });
              },
            },
          },
          dispose: async () => {},
        };
      };
      const plan = () =>
        historyPlan(
          (options, account) => runHistoryOperator(options, account, connect),
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
          assert.deepEqual(error.delta?.why, ["type=CloudflareError", "status=403", "codes=10000"]);
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
