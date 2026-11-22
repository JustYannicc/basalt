import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { seriesFixture } from "./series-fixture.ts";
import { bulkProgressFixture } from "./bulk-progress-fixture.ts";
import { commitBulkChunk } from "../../src/pool/model-history/bulk-progress.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { HistoryConflict } from "../../src/pool/model-history/store.ts";

test("bulk apply replays a lost ACK after a partial chunk without changing receipts or progress", async (t) => {
  await seriesFixture(async ({ db, schema }) => {
    const f = await bulkProgressFixture(schema);
    await insertBulkRequests(db, [f.records[0]!]);
    const calls: string[] = [];
    const query = pg.Client.prototype.query;
    let loseCommit = true;
    t.mock.method(
      pg.Client.prototype,
      "query",
      async function (this: pg.Client, text: string, values?: unknown[]) {
        calls.push(text);
        const result = await Reflect.apply(query, this, [text, values]);
        if (text === "COMMIT" && loseCommit) {
          loseCommit = false;
          throw new Error("Fixture lost ACK");
        }
        return result;
      },
    );
    const apply = (start: number, size: number) =>
      commitBulkChunk(f.connectionString, f.definition, 0, f.data, start, size);
    await assert.rejects(apply(0, 2), /Fixture lost ACK/);
    assert.equal(calls.length, 10, "nine apply calls and the attempted rollback after lost ACK");
    const receipts = async () =>
      (await db.query("SELECT * FROM basalt_model_import_receipts ORDER BY start_row")).rows;
    const saved = await receipts();
    assert.equal(saved.length, 1);
    assert.equal(Number(saved[0]!.inserted), 1);
    assert.equal(Number(saved[0]!.existing), 1);
    calls.length = 0;
    const replay = await apply(0, 2);
    assert.deepEqual(replay, {
      inserted: 1,
      existing: 1,
      count: 2,
      elapsedMs: Number(saved[0]!.elapsed_ms),
    });
    assert.equal(calls.length, 5);
    assert.deepEqual(await receipts(), saved);
    calls.length = 0;
    const next = await apply(2, 2);
    assert.deepEqual(
      { ...next, elapsedMs: 1 },
      { inserted: 2, existing: 0, count: 2, elapsedMs: 1 },
    );
    assert.equal(calls.length, 9);
    const final = await receipts();
    assert.equal(
      final.reduce((sum, row) => sum + Number(row.rows), 0),
      4,
    );
    assert.equal(
      final.reduce((sum, row) => sum + Number(row.inserted), 0),
      3,
    );
    assert.equal(
      final.reduce((sum, row) => sum + Number(row.existing), 0),
      1,
    );
    assert.equal((await db.query("SELECT id FROM basalt_model_requests")).rows.length, 4);
  });
});

test("bulk apply preserves all-existing counts and refuses gaps, overlaps and changed receipts", async (t) => {
  await seriesFixture(async ({ db, schema }) => {
    const f = await bulkProgressFixture(schema);
    await insertBulkRequests(db, f.records);
    const calls: string[] = [];
    const query = pg.Client.prototype.query;
    t.mock.method(
      pg.Client.prototype,
      "query",
      function (this: pg.Client, text: string, values?: unknown[]) {
        calls.push(text);
        return Reflect.apply(query, this, [text, values]);
      },
    );
    const apply = (start: number, size: number, definition = f.definition) =>
      commitBulkChunk(f.connectionString, definition, 0, f.data, start, size);
    await assert.rejects(apply(1, 2), HistoryConflict);
    calls.length = 0;
    const result = await apply(0, 2);
    assert.deepEqual(
      { ...result, elapsedMs: 1 },
      { inserted: 0, existing: 2, count: 2, elapsedMs: 1 },
    );
    assert.equal(calls.length, 8);
    await assert.rejects(apply(1, 2), HistoryConflict);
    await assert.rejects(apply(3, 1), HistoryConflict);
    await assert.rejects(apply(0, 1), HistoryConflict);
    await assert.rejects(
      apply(2, 2, {
        ...f.definition,
        identity: { ...f.definition.identity, owner: "another-owner" },
      }),
      HistoryConflict,
    );
    await db.query("UPDATE basalt_model_import_receipts SET ids_sha=$1", ["a".repeat(64)]);
    await assert.rejects(apply(0, 2), HistoryConflict);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_receipts")).rows.length, 1);
  });
});

test("bulk apply rolls back new history, its job and receipt on equality mismatch", async () => {
  await seriesFixture(async ({ db, schema }) => {
    const f = await bulkProgressFixture(schema);
    await insertBulkRequests(db, [{ ...f.records[1]!, person: "c".repeat(64) }]);
    await assert.rejects(
      commitBulkChunk(f.connectionString, f.definition, 0, f.data),
      HistoryConflict,
    );
    assert.equal((await db.query("SELECT id FROM basalt_model_requests")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_jobs")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_receipts")).rows.length, 0);
  });
});

test("bulk apply rolls back inserted history when receipt persistence fails", async (t) => {
  await seriesFixture(async ({ db, schema }) => {
    const f = await bulkProgressFixture(schema);
    const query = pg.Client.prototype.query;
    t.mock.method(
      pg.Client.prototype,
      "query",
      function (this: pg.Client, text: string, values?: unknown[]) {
        if (text.startsWith("INSERT INTO basalt_model_import_receipts"))
          throw new Error("Fixture receipt failure");
        return Reflect.apply(query, this, [text, values]);
      },
    );
    await assert.rejects(
      commitBulkChunk(f.connectionString, f.definition, 0, f.data),
      /Fixture receipt failure/,
    );
    assert.equal((await db.query("SELECT id FROM basalt_model_requests")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_jobs")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_receipts")).rows.length, 0);
    t.mock.restoreAll();
    const result = await commitBulkChunk(f.connectionString, f.definition, 0, f.data);
    assert.equal(result.inserted, 4);
    assert.equal(result.existing, 0);
    assert.equal(result.count, 4);
  });
});

test("bulk apply retains the nonblocking writer lock before reading job or receipt state", async () => {
  await seriesFixture(async ({ db, schema }) => {
    const f = await bulkProgressFixture(schema);
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('basalt:model-history:bulk-writer-v1',0))",
    );
    await assert.rejects(
      commitBulkChunk(f.connectionString, f.definition, 0, f.data),
      /Bulk import writer is busy/,
    );
    assert.equal((await db.query("SELECT id FROM basalt_model_requests")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_jobs")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_receipts")).rows.length, 0);
    await db.query("ROLLBACK");
  });
});
