import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { historyOperatorOptions, runHistoryOperator } from "./pool-history-operator.ts";
import { HistoryOperatorFailure } from "./pool-history-operator-failure.ts";

import {
  historyAccountTimeSchemaVersion,
  historyAccountTimeStatements,
  historySchemaStatements,
  historySchemaMigrations,
  historySchemaVersion,
  historyTrafficSchemaVersion,
  migrateModelHistory,
  type HistoryDatabase,
} from "../src/pool/model-history/schema.ts";
import { modelHistorySchemaPlan } from "../src/pool/model-history/operator.ts";
import { historyMemoryOwnerFixture, homeMetadataFixture } from "./pool-tests/history-fixture.ts";

import v2Catalog from "./fixtures/model-history-v2-catalog.json" with { type: "json" };
const account = "a".repeat(32);
const report = {
  status: "dry-run",
  version: "model_request_history_v1",
  schemaHash: createHash("sha256").update(JSON.stringify(historySchemaStatements)).digest("hex"),
  catalogHash: createHash("sha256")
    .update(JSON.stringify({ relations: [] }))
    .digest("hex"),
  catalog: { relations: [] },
  applied: false,
  catalogDiff: { createTables: [], conflicts: [] },
  writes: false,
  automaticBackfill: false,
};

test("schema plans never apply, and a lost apply response cannot issue another write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-operator-fixture-"));
  try {
    const path = join(directory, "plan.json");
    const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
    let writes = 0;
    const connect = async (_path: string) => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            if (request.method === "GET") return Response.json(report);
            writes++;
            throw new Error("Response lost after accepting the write");
          },
        },
      },
      dispose: async () => {},
    });
    await runHistoryOperator(options, account, connect);
    assert.equal(writes, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).worker, options.worker);
    // Schema steps are applied only by a release's database step.
    assert.throws(() =>
      historyOperatorOptions(["--worker", "fixture-pool", "--plan", path, "--apply", "--go"]),
    );
    await assert.rejects(
      runHistoryOperator({ ...options, apply: true }, account, connect),
      /applied only by a release/,
    );
    assert.equal(writes, 0);
    await assert.rejects(readFile(`${path}.result.json`), { code: "ENOENT" });

    const backfillPath = join(directory, "backfill.json");
    const backfill = {
      status: "dry-run",
      version: "model_request_backfill_v1",
      digest: "d".repeat(64),
      plan: { rows: "2", upperId: "2", privacyReady: true },
      writes: false,
    };
    const backfillConnect = async (_path: string) => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            if (request.method === "GET") return Response.json(backfill);
            writes++;
            throw new Error("Response lost after accepting the write");
          },
        },
      },
      dispose: async () => {},
    });
    const backfillArgs = ["--worker", "fixture-pool", "--plan", backfillPath];
    await runHistoryOperator(
      historyOperatorOptions([...backfillArgs, "--operation", "backfill"]),
      account,
      backfillConnect,
    );
    const applying = historyOperatorOptions([
      ...backfillArgs,
      "--operation",
      "backfill",
      "--apply",
      "--go",
    ]);
    await assert.rejects(
      runHistoryOperator({ ...applying, worker: "another-pool" }, account, backfillConnect),
    );
    await assert.rejects(
      runHistoryOperator({ ...applying, operation: "journal-activation" }, account, connect),
    );
    assert.equal(writes, 0);
    await assert.rejects(runHistoryOperator(applying, account, backfillConnect));
    assert.equal(writes, 1);
    assert.equal(
      JSON.parse(await readFile(`${backfillPath}.result.json`, "utf8")).status,
      "started",
    );
    await assert.rejects(runHistoryOperator(applying, account, backfillConnect));
    assert.equal(
      writes,
      1,
      "a started receipt blocks an unchanged apply after an uncertain outcome",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backfill has its own dry run and requires both apply and go", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-backfill-fixture-"));
  try {
    const path = join(directory, "backfill.json");
    const args = ["--worker", "fixture-pool", "--plan", path, "--operation", "backfill"];
    const plan = {
      status: "dry-run",
      version: "model_request_backfill_v1",
      digest: "d".repeat(64),
      plan: { rows: "2", upperId: "2", privacyReady: true },
      writes: false,
    };
    const calls: Request[] = [];
    const connect = async (_path: string) => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            calls.push(request.clone());
            return Response.json(
              request.method === "GET"
                ? plan
                : { status: "complete", digest: plan.digest, activated: true },
            );
          },
        },
      },
      dispose: async () => {},
    });
    await runHistoryOperator(historyOperatorOptions(args), account, connect);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(new URL(calls[0]!.url).pathname, "/model-history/backfill");
    assert.throws(() => historyOperatorOptions([...args, "--apply"]));
    assert.throws(() => historyOperatorOptions([...args, "--go"]));
    await runHistoryOperator(
      historyOperatorOptions([...args, "--apply", "--go"]),
      account,
      connect,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, "POST");
    assert.deepEqual(await calls[1]!.json(), { digest: plan.digest, plan: plan.plan, go: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recorded v2 catalog previews the additive SQL without applying it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-v2-fixture-"));
  try {
    const path = join(directory, "plan.json");
    const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
    const calls: Request[] = [];
    const connect = async (_path: string) => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            calls.push(request.clone());
            return Response.json(
              request.method === "GET"
                ? v2Catalog
                : {
                    status: "complete",
                    version: v2Catalog.version,
                    schemaHash: v2Catalog.schemaHash,
                    applied: true,
                    automaticBackfill: false,
                  },
            );
          },
        },
      },
      dispose: async () => {},
    });
    const preview = await runHistoryOperator(options, account, connect);
    const statements = [
      "ALTER TABLE basalt_model_requests ADD COLUMN app_id varchar(256), ADD COLUMN requirement varchar(64)",
    ];
    assert.deepEqual(preview.pendingDdl, statements);
    assert.deepEqual(preview.migrationMarkers, [
      {
        text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)",
        values: [v2Catalog.version],
      },
    ]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.report.pendingDdl, statements);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(new URL(calls[0]!.url).pathname, "/model-history/schema/catalog");
    await assert.rejects(
      runHistoryOperator({ ...options, apply: true }, account, connect),
      /applied only by a release/,
    );
    assert.equal(calls.length, 1, "a schema apply never reaches the Worker");
    await assert.rejects(readFile(`${path}.result.json`), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema catalogs refuse unknown versions and manifests without saving a plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-unknown-fixture-"));
  try {
    for (const change of [
      { version: "model_request_history_v3" },
      { schemaHash: "e".repeat(64) },
      { catalog: { ...v2Catalog.catalog, relations: [] } },
    ]) {
      const path = join(directory, `${Object.keys(change)[0]}.json`);
      const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
      const connect = async (_path: string) => ({
        env: {
          POOL_OPERATIONS: {
            fetch: async (request: Request) => {
              assert.equal(request.method, "GET");
              return Response.json({ ...v2Catalog, ...change });
            },
          },
        },
        dispose: async () => {},
      });
      await assert.rejects(runHistoryOperator(options, account, connect), (error: unknown) => {
        assert.ok(error instanceof HistoryOperatorFailure);
        assert.equal(
          error.field,
          "catalog" in change ? "report.catalogHash" : `report.${Object.keys(change)[0]}`,
        );
        return true;
      });
      await assert.rejects(readFile(path), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v2 previews include the base schema on fresh databases and no DDL after migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-v2-state-fixture-"));
  try {
    for (const applied of [false, true]) {
      const path = join(directory, `${applied}.json`);
      const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
      const catalog = applied ? v2Catalog.catalog : { ...v2Catalog.catalog, relations: [] };
      const connect = async (_path: string) => ({
        env: {
          POOL_OPERATIONS: {
            fetch: async () =>
              Response.json({
                ...v2Catalog,
                applied,
                catalog,
                catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
                catalogDiff: {
                  createTables: applied ? [] : ["basalt_model_requests"],
                  addColumns: applied ? [] : v2Catalog.catalogDiff.addColumns,
                  conflicts: [],
                },
              }),
          },
        },
        dispose: async () => {},
      });
      const preview = await runHistoryOperator(options, account, connect);
      assert.deepEqual(
        preview.pendingDdl,
        applied
          ? []
          : [
              `CREATE TABLE IF NOT EXISTS basalt_model_history_migrations (
      name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
              ...historySchemaMigrations.slice(0, 2).flatMap((migration) => migration.statements),
            ],
      );
      assert.ok(Array.isArray(preview.migrationMarkers));
      assert.equal(preview.migrationMarkers.length, applied ? 0 : 2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing earlier marker and index plan as pending and the release's migrator applies them", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  await historyMemoryOwnerFixture(db);
  await homeMetadataFixture(db);
  await migrateModelHistory(db);
  await db.query("DROP INDEX basalt_model_requests_account_time");
  await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
    historyAccountTimeSchemaVersion,
  ]);

  const directory = await mkdtemp(join(tmpdir(), "history-v7-pending-fixture-"));
  try {
    const path = join(directory, "plan.json");
    const args = ["--worker", "fixture-pool", "--plan", path];
    const connect = async () => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            assert.equal(request.method, "GET", "the operator only plans history schema steps");
            return Response.json({ status: "dry-run", ...(await modelHistorySchemaPlan(db)) });
          },
        },
      },
      dispose: async () => {},
    });

    const preview = await runHistoryOperator(historyOperatorOptions(args), account, connect);
    assert.equal(preview.version, historySchemaVersion);
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.pendingMigrations, [historyAccountTimeSchemaVersion]);
    assert.deepEqual(preview.pendingDdl, historyAccountTimeStatements);

    // The release's database step runs the same migrator.
    await migrateModelHistory(db);
    assert.equal(
      (
        await db.query("SELECT 1 FROM basalt_model_history_migrations WHERE name=$1", [
          historyAccountTimeSchemaVersion,
        ])
      ).rows.length,
      1,
    );
    assert.notEqual(
      (await db.query("SELECT to_regclass('basalt_model_requests_account_time') AS name")).rows[0]
        ?.name,
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await database.close();
  }
});

test("a v4 schema hash cannot approve a v7 migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-prefix-fixture-"));
  try {
    const catalog = { relations: [] };
    const prefix = historySchemaMigrations.slice(0, 4);
    const v4 = {
      status: "dry-run",
      version: historyTrafficSchemaVersion,
      schemaHash: createHash("sha256").update(JSON.stringify(prefix)).digest("hex"),
      catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
      catalog,
      applied: false,
      pendingMigrations: [historySchemaVersion],
      catalogDiff: { createTables: [], conflicts: [] },
      writes: false,
      automaticBackfill: false,
    };
    const path = join(directory, "plan.json");
    const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
    const connect = async () => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async () => Response.json(v4),
        },
      },
      dispose: async () => {},
    });

    await assert.rejects(
      runHistoryOperator(options, account, connect),
      (error: unknown) =>
        error instanceof HistoryOperatorFailure && error.field === "report.pendingMigrations",
    );
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
