import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import {
  historySchemaMigrations,
  migrateModelHistory,
  type HistoryDatabase,
} from "../../src/pool/model-history/schema.ts";
import { historyBulkSchemaVersion } from "../../src/pool/model-history/bulk-schema.ts";
import { historyMemoryOwnerFixture } from "./history-fixture.ts";

test("an existing v6 bulk import journal upgrades through v8 without losing its job", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    await historyMemoryOwnerFixture(db);
    await db.query("CREATE TABLE basalt_model_history_migrations (name text PRIMARY KEY)");
    for (const migration of historySchemaMigrations) {
      for (const sql of migration.statements) await db.query(sql);
      await db.query("INSERT INTO basalt_model_history_migrations VALUES ($1)", [migration.name]);
      if (migration.name === historyBulkSchemaVersion) break;
    }
    const id = "a".repeat(64);
    await db.query(
      `INSERT INTO basalt_model_import_jobs
       (id,pool,organization,owner,manifest_digest,map_digest,total_rows,total_chunks)
       VALUES ($1,'fixture-pool','fixture-org','fixture-owner',$1,$1,1,1)`,
      [id],
    );
    await migrateModelHistory(db);
    const versions = await db.query(
      "SELECT name FROM basalt_model_history_migrations ORDER BY name",
    );
    assert.deepEqual(
      versions.rows.map((row) => row.name),
      [
        "model_request_history_v1",
        "model_request_history_v2_app_attribution",
        "model_request_history_v3_account_time",
        "model_request_history_v4_traffic_purpose",
        "model_request_history_v6_bulk_import",
        "model_request_history_v7_terminal_integrity",
        "model_request_history_v8_import_completion",
      ],
    );
    assert.deepEqual((await db.query("SELECT id,total_rows FROM basalt_model_import_jobs")).rows, [
      { id, total_rows: 1 },
    ]);
    assert.equal((await db.query("SELECT * FROM basalt_model_terminal_starts")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_completion")).rows.length, 0);
    await migrateModelHistory(db);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_jobs")).rows.length, 1);
  } finally {
    await database.close();
  }
});
