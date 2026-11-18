import assert from "node:assert/strict";
import { test } from "node:test";
import { historyInsertFixture, insertAudit, insertPools } from "./history-insert-fixture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";

const cases = [
  [insertPools[0]!],
  Array.from({ length: 100 }, () => insertPools[0]!),
  Array.from({ length: 100 }, (_, i) => insertPools[i % 3]!),
  [null, "app_unmapped_history"],
];
for (const journal of [false, true])
  for (const [index, pools] of cases.entries()) {
    test(`history INSERT preserves invalidation keys for case ${index} with journal ${journal ? "active" : "prepared"}`, async () => {
      await historyInsertFixture(async ({ a, rows, insert, instrumentTriggers }) => {
        const incoming = await rows(pools);
        const run = async () => {
          await a.query("BEGIN");
          await insert(a, incoming);
          const audit = await insertAudit(a);
          await a.query("ROLLBACK");
          return audit;
        };
        const before = await run();
        if (index === 1) assert.equal(before.calls, 100);
        await migrateModelHistory(a);
        await instrumentTriggers();
        const after = await run();
        assert.deepEqual(after.keys, before.keys);
        // Every row still fires and resolves at its own trigger snapshot.
        assert.deepEqual(after.triggers, before.triggers);
        if (!journal) {
          // Before activation each call is a revision, so every legacy call remains.
          assert.deepEqual(after, before);
          return;
        }
        // With the journal one transaction key is one row; repeats were no-op inserts.
        assert.equal(after.calls, after.keys.length);
        assert.deepEqual(
          after.writes,
          after.keys.length
            ? ["basalt_pool_change_batches", "basalt_pool_change_dirty"].map((name) => ({
                name,
                calls: after.keys.length,
              }))
            : [],
        );
      }, journal);
    });
  }

test("multiple history statements coalesce transaction keys and become visible only after commit", async () => {
  await historyInsertFixture(async ({ a, reader, rows, insert }) => {
    const incoming = await rows([insertPools[0]!, insertPools[1]!, insertPools[0]!]);
    const write = async () => {
      await insert(a, [incoming[0]!, incoming[0]!]);
      await insert(a, incoming.slice(0, 2));
      await insert(a, [incoming[2]!]);
      await insert(a, incoming);
      await insert(a, []);
    };
    await a.query("BEGIN");
    await write();
    const before = await insertAudit(a);
    await a.query("ROLLBACK");
    await migrateModelHistory(a);
    const revision = async (pool: string) =>
      (await readPoolHistoryChanges(reader, pool)).find((hint) => hint.topic === "pool-usage")!
        .revision;
    assert.equal(await revision(insertPools[0]!), "0");
    assert.equal(await revision(insertPools[1]!), "0");
    await a.query("BEGIN");
    await write();
    assert.equal(await revision(insertPools[0]!), "0");
    assert.equal(await revision(insertPools[1]!), "0");
    const audit = await insertAudit(a);
    assert.deepEqual(audit.keys, before.keys);
    // The second statement's pool-a row already bumped pool a in this transaction.
    assert.equal(audit.calls, 2);
    assert.equal((await a.query("SELECT * FROM basalt_pool_change_dirty")).rows.length, 2);
    assert.equal((await a.query("SELECT * FROM basalt_pool_change_batches")).rows.length, 1);
    await a.query("COMMIT");
    assert.equal(await revision(insertPools[0]!), "1");
    assert.equal(await revision(insertPools[1]!), "1");
    assert.equal((await reader.query("SELECT id FROM basalt_model_requests")).rows.length, 3);
  });
});

test("hash, group, membership and all-pool target resolution stays legacy-identical", async () => {
  await historyInsertFixture(async ({ a }) => {
    await a.query("INSERT INTO channel_group_detail VALUES(1,2,'fixture-account',NULL)");
    await a.query(
      "INSERT INTO channel_group SELECT 3,string_agg(md5(i::text),''),false,NULL FROM generate_series(1,300) AS i",
    );
    await a.query("UPDATE channel_group SET disabled=true,deleted_at=now() WHERE id=2");
    const hash = (
      await a.query("SELECT left(encode(sha256(convert_to($1,'UTF8')),'hex'),16) AS hash", [
        insertPools[1],
      ])
    ).rows[0]!.hash;
    const cases: [number[] | null, string[] | null, (string | null)[] | null, boolean | null][] = [
      [[], [], [hash], false],
      [[], [], [null, hash, hash], false],
      [[], [], [], false],
      [[], [], null, false],
      [[1], [], [hash], false],
      [[], ["fixture-account"], [], false],
      [[], [], [], true],
      [null, null, [hash], null],
    ];
    const resolve = async () =>
      Promise.all(
        cases.map((parameters) =>
          a
            .query(
              "SELECT * FROM basalt_pool_change_targets($1::bigint[],$2::text[],$3::text[],$4::boolean) ORDER BY pool",
              parameters,
            )
            .then((result) => result.rows),
        ),
      );
    const before = await resolve();
    await migrateModelHistory(a);
    assert.deepEqual(await resolve(), before);
  });
});
