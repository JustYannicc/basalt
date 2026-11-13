import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";
import { modelHistorySchemaPlan } from "../../src/pool/model-history/operator.ts";
import {
  historyChangeSchemaVersion,
  historySchemaMigrations,
  historySchemaVersion,
  migrateModelHistory,
} from "../../src/pool/model-history/schema.ts";
import { historyImportCompletionVersion } from "../../src/pool/model-history/import-completion-schema.ts";
import { homeMetadataFixture } from "./history-fixture.ts";
import { seriesFixture } from "./series-fixture.ts";

test("missing v5 applies after retained v8 and publishes real history writes without replaying migrations", async () => {
  const index = historySchemaMigrations.findIndex((m) => m.name === historyChangeSchemaVersion);
  assert.ok(index >= 0);
  const [change] = historySchemaMigrations.splice(index, 1);
  assert.ok(change);
  let registered = false;
  try {
    await seriesFixture(async ({ db, insert }) => {
      assert.equal(historySchemaVersion, historyImportCompletionVersion);
      const pool = "app_late_history_changes";
      const poolHash = (await digest(pool)).slice(0, 16);
      const [old] = await insert({ pool: poolHash });
      assert.ok(old);
      await db.query("SET ROLE basalt_pool_owner");
      try {
        await homeMetadataFixture(db);
      } finally {
        await db.query("RESET ROLE");
      }
      const retained = (
        await db.query("SELECT row_to_json(r)::text AS row FROM basalt_model_requests r")
      ).rows;
      const markers = (
        await db.query(
          "SELECT name,completed_at::text AS at FROM basalt_model_history_migrations ORDER BY name",
        )
      ).rows;
      assert.ok(markers.some((row) => row.name === historyImportCompletionVersion));
      assert.ok(!markers.some((row) => row.name === historyChangeSchemaVersion));
      assert.equal(
        (await db.query("SELECT to_regclass('basalt_pool_change_heads') AS name")).rows[0]?.name,
        null,
      );

      historySchemaMigrations.splice(index, 0, change);
      registered = true;
      const plan = await modelHistorySchemaPlan(db);
      assert.deepEqual(plan.pendingMigrations, [historyChangeSchemaVersion]);
      assert.deepEqual(plan.catalogDiff.createTables, [
        "basalt_pool_change_heads",
        "basalt_pool_change_pending",
      ]);
      assert.deepEqual(plan.catalogDiff.conflicts, []);
      await migrateModelHistory(db);
      const applied = (
        await db.query(
          "SELECT name,completed_at::text AS at FROM basalt_model_history_migrations ORDER BY name",
        )
      ).rows;
      assert.deepEqual(
        applied.filter((row) => row.name !== historyChangeSchemaVersion),
        markers,
      );
      assert.equal(applied.filter((row) => row.name === historyChangeSchemaVersion).length, 1);
      assert.deepEqual(
        (await db.query("SELECT row_to_json(r)::text AS row FROM basalt_model_requests r")).rows,
        retained,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::text AS count FROM pg_trigger WHERE tgrelid='basalt_model_requests'::regclass AND tgname='basalt_pool_change_write'",
          )
        ).rows[0]?.count,
        "1",
      );
      assert.deepEqual(await readPoolHistoryChanges(db, pool), [
        { topic: "pool-readings", resource: pool, revision: "0" },
        { topic: "pool-usage", resource: pool, revision: "0" },
      ]);
      await insert({ pool: poolHash });
      assert.deepEqual(await readPoolHistoryChanges(db, pool), [
        { topic: "pool-readings", resource: pool, revision: "0" },
        { topic: "pool-usage", resource: pool, revision: "1" },
      ]);
      assert.deepEqual(
        (await db.query("SELECT pool,topic,revision::text FROM basalt_pool_change_pending")).rows,
        [{ pool, topic: "pool-usage", revision: "1" }],
      );
      await migrateModelHistory(db);
      assert.deepEqual(
        (
          await db.query(
            "SELECT name,completed_at::text AS at FROM basalt_model_history_migrations ORDER BY name",
          )
        ).rows,
        applied,
      );
      assert.deepEqual((await modelHistorySchemaPlan(db)).pendingMigrations, []);
    });
  } finally {
    if (!registered) historySchemaMigrations.splice(index, 0, change);
  }
});
