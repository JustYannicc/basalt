import assert from "node:assert/strict";
import { test } from "node:test";
import { historyInsertFixture, insertPools } from "./history-insert-fixture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import {
  historyRowSchemaVersion,
  historyRowStatements,
} from "../../src/pool/model-history/history-row-schema.ts";
import {
  historyBulkColumns,
  historyBulkInvalidationVersion,
} from "../../src/pool/model-history/history-bulk-schema.ts";
import { historyRecordLayout } from "../../src/pool/model-history/store.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";

test("v12 bounds trigger-switch blocking, preserves the old writer, and applies once", async () => {
  await historyInsertFixture(async ({ a, b, reader, rows, insert }) => {
    for (const statement of historyRowStatements) await a.query(statement);
    await a.query("INSERT INTO basalt_model_history_migrations(name) VALUES($1)", [
      historyRowSchemaVersion,
    ]);
    const incoming = await rows([insertPools[0]!, insertPools[0]!]);
    const revision = async () =>
      (await readPoolHistoryChanges(reader, insertPools[0]!)).find((h) => h.topic === "pool-usage")!
        .revision;
    assert.equal(await revision(), "0");
    const old = (
      await reader.query(
        "SELECT pg_get_triggerdef(oid) AS sql FROM pg_trigger WHERE tgrelid='basalt_model_requests'::regclass AND tgname='basalt_pool_change_write'",
      )
    ).rows;
    await a.query("BEGIN");
    await insert(a, [incoming[0]!]);
    await assert.rejects(migrateModelHistory(b), { code: "55P03" });
    assert.deepEqual(
      (
        await reader.query(
          "SELECT pg_get_triggerdef(oid) AS sql FROM pg_trigger WHERE tgrelid='basalt_model_requests'::regclass AND tgname='basalt_pool_change_write'",
        )
      ).rows,
      old,
    );
    assert.equal(
      (
        await reader.query("SELECT name FROM basalt_model_history_migrations WHERE name=$1", [
          historyBulkInvalidationVersion,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await reader.query(
          "SELECT to_regprocedure('basalt_model_history_bulk_insert(text,jsonb)') AS fn",
        )
      ).rows[0]!.fn,
      null,
    );
    await a.query("COMMIT");
    assert.equal(await revision(), "1");
    await migrateModelHistory(b);
    const markers = (
      await reader.query("SELECT * FROM basalt_model_history_migrations ORDER BY name")
    ).rows;
    const functions = (
      await reader.query(
        "SELECT oid FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid",
      )
    ).rows;
    await migrateModelHistory(b);
    assert.deepEqual(
      (await reader.query("SELECT * FROM basalt_model_history_migrations ORDER BY name")).rows,
      markers,
    );
    assert.deepEqual(
      (
        await reader.query(
          "SELECT oid FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid",
        )
      ).rows,
      functions,
    );
    await a.query("BEGIN");
    await insertBulkRequests(a, [incoming[1]!], insertPools[0]!);
    await a.query("COMMIT");
    assert.equal(await revision(), "2");
    assert.equal(
      (await reader.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
      2,
    );
  });
});

test("v12 rejects invalid scope, malformed input and oversized direct SQL without any row", async () => {
  await historyInsertFixture(async ({ a }) => {
    await migrateModelHistory(a);
    for (const [pool, records] of [
      [null, []],
      ["unscoped", []],
      [insertPools[0], null],
      [insertPools[0], {}],
      [insertPools[0], Array.from({ length: 5001 }, () => ({}))],
    ]) {
      await assert.rejects(
        a.query("SELECT basalt_model_history_bulk_insert($1,$2::jsonb)", [
          pool,
          JSON.stringify(records),
        ]),
        { code: "22023" },
      );
    }
    assert.equal(
      (await a.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
      0,
    );
  });
});

test("a history column added after v12 needs a new bulk function version", () => {
  // The bulk path would otherwise store the new column as its default without any refusal.
  assert.deepEqual(
    historyBulkColumns.split(",").map((name) => name.trim()),
    historyRecordLayout(true).names,
  );
});
