import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { backendUserName } from "../../src/pool/backend-users.ts";
import { activateHomeBackfill, planHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";
import {
  historySchemaMigrations,
  migrateModelHistory,
  type HistoryDatabase,
} from "../../src/pool/model-history/schema.ts";
import {
  historyMemoryOwnerFixture,
  historySchemaFixture,
  homeMetadataFixture,
} from "./history-fixture.ts";

const admin = process.env.POOL_TEST_ADMIN_URL;
if (admin && !["127.0.0.1", "localhost"].includes(new URL(admin).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to isolated local test Postgres");

test("capture preserves old-schema history and begins pending delivery after the additive migration", async () => {
  const schema = `capture_compat_${randomUUID().replaceAll("-", "")}`;
  const client = admin ? new pg.Client({ connectionString: admin }) : null;
  const memory = client ? null : new PGlite();
  const db: HistoryDatabase = client ?? {
    query: async (text, values) => {
      const result = await memory!.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    if (client) {
      await client.connect();
      await historySchemaFixture(db, schema);
      await db.query(`SET search_path TO ${schema}`);
      await db.query("SET ROLE basalt_pool_owner");
    } else {
      await historyMemoryOwnerFixture(db);
    }
    await homeMetadataFixture(db);
    await db.query(
      "CREATE TABLE basalt_model_history_migrations (name text PRIMARY KEY,completed_at timestamptz DEFAULT CURRENT_TIMESTAMP)",
    );
    for (const migration of historySchemaMigrations) {
      if (migration.name === "model_request_history_v5_change_revisions") continue;
      for (const statement of migration.statements) await db.query(statement);
      await db.query("INSERT INTO basalt_model_history_migrations(name) VALUES($1)", [
        migration.name,
      ]);
    }
    const pool = "app_capture_compat";
    await db.query('INSERT INTO "user" VALUES(1,$1)', [await backendUserName("person", pool)]);
    await db.query("INSERT INTO api_key VALUES(1,$1,1,NULL)", [`sha256:${"a".repeat(64)}`]);
    const add = (id: number) =>
      db.query(
        `INSERT INTO usage(id,timestamp,request_id,api_key)
      VALUES($1,'2026-01-01T00:00:00Z',$2,$3)`,
        [id, `attempt-${id}`, `sha256:${"a".repeat(64)}`],
      );
    await add(1);
    assert.deepEqual(await captureHomeRequests(db), { state: "inactive", pending: [] });
    await activateHomeBackfill(db, await planHomeBackfill(db));
    const before = await captureHomeRequests(db);
    assert.equal(before.state, "active");
    assert.deepEqual(before.pending, []);
    const retained = (await db.query("SELECT * FROM basalt_model_requests ORDER BY id")).rows;
    assert.equal(retained.length, 1);
    await migrateModelHistory(db);
    await migrateModelHistory(db);
    assert.deepEqual(
      (await db.query("SELECT * FROM basalt_model_requests ORDER BY id")).rows,
      retained,
    );
    await readPoolHistoryChanges(db, pool);
    await db.query("UPDATE api_key SET display_name='changed' WHERE id=1");
    const after = await captureHomeRequests(db);
    assert.equal(after.state, "active");
    assert.ok(
      after.pending.some(
        (change) => change.hint.resource === pool && change.hint.topic === "pool-readings",
      ),
    );
    await add(2);
    await captureHomeRequests(db);
    assert.equal(
      (await db.query("SELECT count(*)::text AS n FROM basalt_model_requests")).rows[0]!.n,
      "2",
    );
  } finally {
    if (client) {
      try {
        await client.query("ROLLBACK").catch(() => {});
        await client.query("RESET ROLE");
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await client.end();
      }
    } else {
      await memory!.close();
    }
  }
});
