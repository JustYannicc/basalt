import assert from "node:assert/strict";
import { test } from "node:test";
import { historyInsertFixture, insertAudit, insertPools } from "./history-insert-fixture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";
import { readRequests, recordValues } from "../../src/pool/model-history/store.ts";

for (const journal of [false, true]) {
  test(`coarse bulk writes preserve rows and visible history with ${journal ? "active" : "prepared"} journal`, async () => {
    const run = (coarse: boolean) =>
      historyInsertFixture(async ({ a, reader, rows, insert }) => {
        await migrateModelHistory(a);
        const incoming = await rows(Array.from({ length: 100 }, () => insertPools[0]!));
        const revision = async () =>
          (await readPoolHistoryChanges(reader, insertPools[0]!)).find(
            (hint) => hint.topic === "pool-usage",
          )!.revision;
        const page = () =>
          readRequests(reader, {
            pool: incoming[0]!.pool!,
            from: "2026-01-01T00:00:00Z",
            to: "2026-01-02T00:00:00Z",
          });
        const before = await revision();
        const cached = await page();
        assert.equal(cached.records.length, 0);
        await a.query("BEGIN");
        if (coarse) await insertBulkRequests(a, incoming, insertPools[0]!);
        else await insert(a, incoming);
        // Prepared producers update the head row, so registration waits for the writer.
        // Read its committed revision without taking registration's write lock.
        const during = journal
          ? await revision()
          : String(
              (
                await reader.query(
                  "SELECT basalt_pool_change_revision($1,'pool-usage') AS revision",
                  [insertPools[0]],
                )
              ).rows[0]!.revision,
            );
        assert.equal(during, before, "uncommitted data cannot invalidate a reader");
        assert.deepEqual(await page(), cached);
        const audit = await insertAudit(a);
        assert.equal(audit.calls, coarse ? 1 : 100);
        await a.query("COMMIT");
        assert.notEqual(await revision(), before);
        const visible = await page();
        assert.equal(visible.records.length, 100);
        const stored = (
          await a.query(
            "SELECT to_jsonb(r)-'ingested_at' AS row FROM basalt_model_requests r ORDER BY id",
          )
        ).rows;
        return {
          stored,
          visible: visible.records.map(({ ingested_at: _ingested, ...record }) => record),
          keys: audit.keys,
        };
      }, journal);
    assert.deepEqual(await run(true), await run(false));
  });
}

test("bulk bypass is confined to its pool and function, including rollback and live writes in the same transaction", async () => {
  await historyInsertFixture(async ({ a, reader, rows, insert }) => {
    await migrateModelHistory(a);
    const incoming = await rows([insertPools[0]!, insertPools[0]!, insertPools[1]!]);
    await a.query("BEGIN");
    await insertBulkRequests(a, [incoming[0]!], insertPools[0]!);
    await insert(a, [incoming[1]!, incoming[2]!]);
    assert.equal(
      (await insertAudit(a)).calls,
      3,
      "one coarse call plus two unchanged live row calls",
    );
    assert.equal(
      (await reader.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
      0,
    );
    await a.query("ROLLBACK");
    assert.equal((await insertAudit(a)).calls, 0);
    assert.equal(
      (await a.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
      0,
    );
    await a.query("BEGIN");
    await a.query("SAVEPOINT rejected_bulk");
    await assert.rejects(
      a.query("SELECT basalt_model_history_bulk_insert($1,$2::jsonb)", [
        insertPools[0],
        JSON.stringify([recordValues(incoming[2]!)]),
      ]),
      { code: "22023" },
    );
    await a.query("ROLLBACK TO SAVEPOINT rejected_bulk");
    // A failure after the bypass is set must not leave it set for later live inserts.
    await a.query("SAVEPOINT failed_insert");
    await assert.rejects(
      a.query("SELECT basalt_model_history_bulk_insert($1,$2::jsonb)", [
        insertPools[0],
        JSON.stringify([{ ...recordValues(incoming[0]!), model: "x".repeat(300) }]),
      ]),
      { code: "22001" },
    );
    await a.query("ROLLBACK TO SAVEPOINT failed_insert");
    await insert(a, [incoming[0]!]);
    assert.equal((await insertAudit(a)).calls, 1);
    await a.query("COMMIT");
  });
});

test("bulk invalidation never resolves mappings and cannot commit rows if invalidation fails", async () => {
  await historyInsertFixture(async ({ a, rows, insert }) => {
    await migrateModelHistory(a);
    const incoming = await rows([insertPools[0]!, insertPools[0]!]);
    await a.query(`CREATE OR REPLACE FUNCTION basalt_pool_change_targets(group_ids bigint[], auth_ids text[], pool_hashes text[], all_pools boolean DEFAULT false)
      RETURNS TABLE(pool text) LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'resolver must not run'; END $$`);
    await a.query("BEGIN");
    await insertBulkRequests(a, [incoming[0]!], insertPools[0]!);
    await a.query("COMMIT");
    await assert.rejects(insert(a, [incoming[1]!]), /resolver must not run/);
    await a.query(`CREATE OR REPLACE FUNCTION basalt_pool_change(pool_id text, change_topic text) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'invalidation refused'; END $$`);
    await a.query("BEGIN");
    await assert.rejects(
      insertBulkRequests(a, [incoming[1]!], insertPools[0]!),
      /invalidation refused/,
    );
    await a.query("ROLLBACK");
    assert.equal(
      (await a.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
      1,
    );
  });
});
