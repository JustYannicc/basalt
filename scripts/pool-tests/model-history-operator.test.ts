import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { handleModelHistoryOperation, historyBackfillPath, historySchemaApplyPath, historySchemaCatalogPath } from "../../src/pool/model-history/operator.ts";
import { loadMiniflare } from "../startup-profiler/profile.ts";
import { readBundle } from "../worker-startup.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to isolated local test Postgres");

test("the private schema operator defaults to catalog/count reads and binds writes to the reviewed schema and catalog", async () => {
  const schema = `operator_${randomUUID().replaceAll("-", "")}`;
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query("CREATE TABLE usage (id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL)");
    await db.query("INSERT INTO usage (timestamp) VALUES ('2020-01-01T00:00:00Z'),('2020-01-02T00:00:00Z')");
    await db.query("CREATE TABLE home_data_migration (name text,completed boolean)");
    await db.query("INSERT INTO home_data_migration VALUES ('diagnostics_metadata_only_v1_1_6',true)");
    const url = new URL(adminUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const before = await db.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema]);
    const bundle = readBundle("PoolWorker", ".alchemy/bundles/PoolWorker");
    const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
    const worker = new Miniflare(convertV4MiniflareOptions({ workers: [{
      name: "pool",
      compatibilityDate: "2026-09-08", compatibilityFlags: ["nodejs_compat"], modulesRoot: "/",
      modules: bundle.modules.map((file) => ({ type: file.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
        path: join(bundle.directory, file), contents: readFileSync(join(bundle.directory, file)) })),
      bindings: { POOL_DATABASE_URL: url.toString(), POOL_MANAGEMENT_KEY: "fixture-management",
        POOL_IMAGE_HASH: "fixture", POOL_APP_SIGNING_KEY: "ab".repeat(32) },
      durableObjects: { PoolContainer: { className: "PoolContainer", useSQLite: true } },
    }, {
      name: "operator", compatibilityDate: "2026-09-08", modules: true,
      script: "export default { fetch(request, env) { return env.POOL_OPERATIONS.fetch(request); } };",
      serviceBindings: { POOL_OPERATIONS: { name: "pool", entrypoint: "PoolOperations" } },
    }] }));
    try {
      await worker.ready;
      const publicPool = await worker.getWorker("pool");
      for (const path of [historySchemaCatalogPath, historySchemaApplyPath, historyBackfillPath]) {
        const response = await publicPool.fetch(`http://pool${path}`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ go: true }) });
        assert.equal(response.status, 404, "operator actions must not be exposed by the public Worker");
        await response.body?.cancel();
      }
      const operator = await worker.getWorker("operator");
      const catalog = await operator.fetch(`http://operator${historySchemaCatalogPath}`);
      assert.equal(catalog.status, 200, await catalog.clone().text());
      const preview = await catalog.json();
      assert.equal(preview.writes, false);
      assert.equal(preview.history.rows, "2");
      assert.equal(preview.history.privacyReady, true);
      assert.equal(preview.catalogDiff.createTables.length, 19);
      const backfill = await operator.fetch(`http://operator${historyBackfillPath}`);
      assert.equal(backfill.status, 200, await backfill.clone().text());
      assert.equal((await backfill.json()).writes, false);
    } finally { await worker.dispose(); }
    assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema])).rows, before.rows,
      "starting the deployed Worker must not create or migrate history tables");
    assert.equal((await db.query("SELECT count(*)::text AS rows FROM usage")).rows[0].rows, "2",
      "Worker deployment must leave existing Home history untouched");
    const invoke = (path: string, body?: object) => handleModelHistoryOperation(new Request(`http://operator${path}`,
      body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), url.toString());
    const dry = await invoke(historySchemaCatalogPath);
    assert.equal(dry.status, 200, await dry.clone().text());
    const plan = await dry.json() as { schemaHash: string; catalogHash: string; writes: boolean; applied: boolean;
      history: { rows: string; privacyReady: boolean }; ledgerRows: string; catalogDiff: { createTables: string[] } };
    assert.equal(plan.writes, false);
    assert.equal(plan.history.rows, "2");
    assert.equal(plan.history.privacyReady, true);
    assert.equal(plan.ledgerRows, "0");
    assert.equal(plan.catalogDiff.createTables.length, 19);
    assert.equal((await db.query("SELECT to_regclass('basalt_model_requests') AS name")).rows[0].name, null);
    const approved = { go: true, schemaHash: plan.schemaHash, catalogHash: plan.catalogHash };
    assert.equal((await invoke(historySchemaApplyPath, { ...approved, go: false })).status, 400);
    assert.equal((await invoke(historySchemaApplyPath, { ...approved, schemaHash: "0".repeat(64) })).status, 409);
    assert.equal((await db.query("SELECT to_regclass('basalt_model_requests') AS name")).rows[0].name, null);
    assert.equal((await invoke(historySchemaApplyPath, approved)).status, 200);
    assert.equal((await db.query("SELECT count(*)::text AS rows FROM basalt_model_requests")).rows[0].rows, "0",
      "schema application must not backfill metadata silently");
    assert.equal((await invoke(historySchemaApplyPath, approved)).status, 409, "catalog changes invalidate an old plan");
    const refreshed = await (await invoke(historySchemaCatalogPath)).json() as typeof plan;
    assert.equal(refreshed.applied, true);
    assert.equal(refreshed.catalogDiff.createTables.length, 0);
    assert.equal(refreshed.writes, false);
    assert.equal((await db.query("SELECT count(*)::text AS rows FROM basalt_model_history_cursor")).rows[0].rows, "0",
      "schema application must not activate capture");
    const backfill = await (await invoke(historyBackfillPath)).json() as { digest: string; plan: object; writes: boolean };
    assert.equal(backfill.writes, false);
    assert.equal((await invoke(historyBackfillPath, { ...backfill, go: false })).status, 400);
    assert.equal((await invoke(historyBackfillPath, { ...backfill, digest: "0".repeat(64), go: true })).status, 409);
    assert.equal((await db.query("SELECT count(*)::text AS rows FROM basalt_model_history_cursor")).rows[0].rows, "0");
    await db.query("UPDATE home_data_migration SET completed=false");
    assert.equal((await invoke(historyBackfillPath, { ...backfill, go: true })).status, 503,
      "privacy readiness must still hold when an approved plan activates");
    await db.query("UPDATE home_data_migration SET completed=true");
    assert.equal((await invoke(historyBackfillPath, { ...backfill, go: true })).status, 200);
    assert.equal((await db.query("SELECT backfill_id::text AS start,backfill_upper::text AS upper_id FROM basalt_model_history_cursor")).rows[0].start, "0");
    assert.equal((await db.query("SELECT backfill_upper::text AS upper_id FROM basalt_model_history_cursor")).rows[0].upper_id, "2");
    assert.equal((await db.query("SELECT count(*)::text AS rows FROM basalt_model_requests")).rows[0].rows, "0",
      "activation schedules bounded collection without copying rows in the operator request");
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
});
