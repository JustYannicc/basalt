import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { historyOperatorOptions, runHistoryOperator } from "./pool-history-operator.ts";

import { historySchemaStatements, historySchemaMigrations } from "../src/pool/model-history/schema.ts";

import v2Catalog from "./fixtures/model-history-v2-catalog.json" with { type: "json" };
const account = "a".repeat(32);
const report = { status: "dry-run", version: "model_request_history_v1", schemaHash: createHash("sha256").update(JSON.stringify(historySchemaStatements)).digest("hex"),
  catalogHash: createHash("sha256").update(JSON.stringify({ relations: [] })).digest("hex"), catalog: { relations: [] }, applied: false, catalogDiff: { createTables: [], conflicts: [] }, writes: false, automaticBackfill: false };

test("operator plans bind the target and a lost apply response cannot issue another write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-operator-fixture-"));
  try {
    const path = join(directory, "plan.json");
    const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
    let writes = 0;
    const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
      if (request.method === "GET") return Response.json(report);
      writes++;
      throw new Error("Response lost after accepting the write");
    } } }, dispose: async () => {} });
    await runHistoryOperator(options, account, connect);
    assert.equal(writes, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).worker, options.worker);
    assert.throws(() => historyOperatorOptions(["--worker", "fixture-pool", "--plan", path, "--apply"]));
    const applying = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path, "--apply", "--go"]);
    await assert.rejects(runHistoryOperator({ ...applying, worker: "another-pool" }, account, connect));
    await assert.rejects(runHistoryOperator({ ...applying, operation: "backfill" }, account, connect));
    assert.equal(writes, 0);
    await assert.rejects(runHistoryOperator(applying, account, connect));
    assert.equal(writes, 1);
    assert.equal(JSON.parse(await readFile(`${path}.result.json`, "utf8")).status, "started");
    await assert.rejects(runHistoryOperator(applying, account, connect));
    assert.equal(writes, 1, "a started receipt blocks an unchanged apply after an uncertain outcome");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("backfill has its own dry run and requires both apply and go", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-backfill-fixture-"));
  try {
    const path = join(directory, "backfill.json");
    const args = ["--worker", "fixture-pool", "--plan", path, "--operation", "backfill"];
    const plan = { status: "dry-run", version: "model_request_backfill_v1", digest: "d".repeat(64),
      plan: { rows: "2", upperId: "2", privacyReady: true }, writes: false };
    const calls: Request[] = [];
    const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
      calls.push(request.clone());
      return Response.json(request.method === "GET" ? plan : { status: "complete", digest: plan.digest, activated: true });
    } } }, dispose: async () => {} });
    await runHistoryOperator(historyOperatorOptions(args), account, connect);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(new URL(calls[0]!.url).pathname, "/model-history/backfill");
    assert.throws(() => historyOperatorOptions([...args, "--apply"]));
    assert.throws(() => historyOperatorOptions([...args, "--go"]));
    await runHistoryOperator(historyOperatorOptions([...args, "--apply", "--go"]), account, connect);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, "POST");
    assert.deepEqual(await calls[1]!.json(), { digest: plan.digest, plan: plan.plan, go: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("recorded v2 catalog previews the additive SQL and applies only its saved hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-v2-fixture-"));
  try {
    const path = join(directory, "plan.json");
    const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
    const calls: Request[] = [];
    const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
      calls.push(request.clone());
      return Response.json(request.method === "GET" ? v2Catalog : {
        status: "complete", version: v2Catalog.version, schemaHash: v2Catalog.schemaHash, applied: true,
        automaticBackfill: false,
      });
    } } }, dispose: async () => {} });
    const preview = await runHistoryOperator(options, account, connect);
    const statements = ["ALTER TABLE basalt_model_requests ADD COLUMN app_id varchar(256), ADD COLUMN requirement varchar(64)"];
    assert.deepEqual(preview.pendingDdl, statements);
    assert.deepEqual(preview.migrationMarkers, [{
      text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", values: [v2Catalog.version],
    }]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.report.pendingDdl, statements);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(new URL(calls[0]!.url).pathname, "/model-history/schema/catalog");
    const applying = { ...options, apply: true };
    await writeFile(path, JSON.stringify({ ...saved, report: { ...saved.report, pendingDdl: ["DROP TABLE basalt_model_requests"] } }));
    await assert.rejects(runHistoryOperator(applying, account, connect), /statements changed/);
    assert.equal(calls.length, 1);
    await writeFile(path, JSON.stringify({ ...saved, report: { ...saved.report, applied: true, pendingDdl: [], migrationMarkers: [] } }));
    await assert.rejects(runHistoryOperator(applying, account, connect), /plan changed/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, "GET");
    await assert.rejects(readFile(`${path}.result.json`), { code: "ENOENT" });
    await writeFile(path, JSON.stringify(saved));
    await runHistoryOperator(applying, account, connect);
    assert.equal(calls.length, 4);
    assert.equal(calls[2]!.method, "GET");
    assert.equal(new URL(calls[3]!.url).pathname, "/model-history/schema");
    assert.deepEqual(await calls[3]!.json(), { schemaHash: v2Catalog.schemaHash, catalogHash: v2Catalog.catalogHash, go: true });
    assert.equal(JSON.parse(await readFile(`${path}.result.json`, "utf8")).status, "complete");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("schema catalogs refuse unknown versions and manifests without saving an apply plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-unknown-fixture-"));
  try {
    for (const change of [{ version: "model_request_history_v3" }, { schemaHash: "e".repeat(64) }, { catalog: { ...v2Catalog.catalog, relations: [] } }]) {
      const path = join(directory, `${Object.keys(change)[0]}.json`);
      const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
      const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
        assert.equal(request.method, "GET");
        return Response.json({ ...v2Catalog, ...change });
      } } }, dispose: async () => {} });
      await assert.rejects(runHistoryOperator(options, account, connect));
      await assert.rejects(readFile(path), { code: "ENOENT" });
      await writeFile(path, JSON.stringify({ accountId: account, worker: options.worker, operation: "schema", report: { ...v2Catalog, ...change } }));
      await assert.rejects(runHistoryOperator({ ...options, apply: true }, account, async () => { throw new Error("must reject before connecting"); }), /Invalid history schema plan|Unknown history schema statements|catalog hash changed/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("v2 previews include the base schema on fresh databases and no DDL after migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-v2-state-fixture-"));
  try {
    for (const applied of [false, true]) {
      const path = join(directory, `${applied}.json`);
      const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
      const catalog = applied ? v2Catalog.catalog : { ...v2Catalog.catalog, relations: [] };
      const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async () => Response.json({
        ...v2Catalog, applied, catalog, catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"), catalogDiff: { createTables: applied ? [] : ["basalt_model_requests"],
          addColumns: applied ? [] : v2Catalog.catalogDiff.addColumns, conflicts: [] },
      }) } }, dispose: async () => {} });
      const preview = await runHistoryOperator(options, account, connect);
      assert.deepEqual(preview.pendingDdl, applied ? [] : [
        `CREATE TABLE IF NOT EXISTS basalt_model_history_migrations (
      name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        ...historySchemaMigrations.flatMap(migration => migration.statements),
      ]);
      assert.ok(Array.isArray(preview.migrationMarkers));
      assert.equal(preview.migrationMarkers.length, applied ? 0 : 2);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("v1 refuses edited previews and stale catalog state before any apply request or receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-v1-refusal-fixture-"));
  try {
    const path = join(directory, "plan.json");
    const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
    let current = Response.json(report);
    const calls: Request[] = [];
    const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
      calls.push(request.clone());
      assert.equal(request.method, "GET", "edited or stale plans must never reach POST");
      return current.clone();
    } } }, dispose: async () => {} });
    const preview = await runHistoryOperator(options, account, connect);
    const saved = JSON.parse(await readFile(path, "utf8"));
    const applying = { ...options, apply: true };
    for (const change of [{ pendingDdl: [] }, { migrationMarkers: [] }]) {
      await writeFile(path, JSON.stringify({ ...saved, report: { ...saved.report, ...change } }));
      await assert.rejects(runHistoryOperator(applying, account, connect), /statements changed/);
      assert.equal(calls.length, 1, "edited previews refuse before opening the binding");
      await assert.rejects(readFile(`${path}.result.json`), { code: "ENOENT" });
    }
    assert.ok(Array.isArray(preview.pendingDdl));
    const appliedReport = { ...saved.report, applied: true,
      pendingDdl: preview.pendingDdl.slice(0, 1), migrationMarkers: [] };
    await writeFile(path, JSON.stringify({ ...saved, report: appliedReport }));
    await assert.rejects(runHistoryOperator(applying, account, connect), /plan changed/);
    assert.equal(calls.length, 2, "edited applied state refuses after refreshing the catalog");
    await assert.rejects(readFile(`${path}.result.json`), { code: "ENOENT" });
    await writeFile(path, JSON.stringify(saved));
    const catalog = { relations: [
      { name: "basalt_model_history_migrations", kind: "r" },
      { name: "basalt_model_requests", kind: "p" },
    ] };
    current = Response.json({ ...report, applied: true, catalog,
      catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex") });
    await assert.rejects(runHistoryOperator(applying, account, connect), /plan changed/);
    assert.equal(calls.length, 3, "a changed catalog refuses after refreshing and before POST");
    await assert.rejects(readFile(`${path}.result.json`), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
