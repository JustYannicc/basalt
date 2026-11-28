import assert from "node:assert/strict";
import { test } from "node:test";
import { seriesFixture } from "./series-fixture.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { HistoryConflict } from "../../src/pool/model-history/store.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";

test("bulk storage uses one precheck and never rechecks rows it inserted", async () => {
  await seriesFixture(async ({ db, row }) => {
    const records = await Promise.all(Array.from({ length: 100 }, () => row()));
    const calls: { text: string; values: unknown[] | undefined }[] = [];
    const measured: HistoryDatabase = {
      query(text, values) {
        calls.push({ text, values });
        return db.query(text, values);
      },
    };
    for (const [incoming, expected, queries] of [
      [records.slice(0, 50), { inserted: 50, existing: 0, count: 50 }, 3],
      [records, { inserted: 50, existing: 50, count: 100 }, 3],
      [records, { inserted: 0, existing: 100, count: 100 }, 2],
      [[records[0]!, records[0]!], { inserted: 0, existing: 1, count: 1 }, 2],
    ] as const) {
      calls.length = 0;
      assert.deepEqual(await insertBulkRequests(measured, incoming), expected);
      assert.equal(calls.length, queries);
      assert.equal(calls.filter(({ text }) => text.includes("AS conflict")).length, 1);
      const insert = calls.find(({ text }) => text.includes("INSERT INTO basalt_model_requests"));
      if (insert) assert.equal(JSON.parse(String(insert.values![0])).length, expected.inserted);
    }
  });
});

test("a conflicting row rolls back fresh history", async () => {
  await seriesFixture(async ({ db, row }) => {
    const saved = await row();
    const fresh = await row();
    await insertBulkRequests(db, [saved]);
    const snapshot = async () =>
      (await db.query("SELECT to_jsonb(r) AS row FROM basalt_model_requests r ORDER BY id")).rows;
    const before = await snapshot();
    for (const change of [{ person: "c".repeat(64) }, { totalTokens: "999" }]) {
      await db.query("BEGIN");
      await assert.rejects(
        insertBulkRequests(db, [fresh, { ...saved, ...change }]),
        HistoryConflict,
      );
      await db.query("ROLLBACK");
      assert.deepEqual(await snapshot(), before);
    }
  });
});
