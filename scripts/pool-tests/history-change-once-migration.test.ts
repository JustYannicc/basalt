import assert from "node:assert/strict";
import { test } from "node:test";
import { historyChangeOnceStatements } from "../../src/pool/model-history/history-row-schema.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { homeChangeFixture, pools, produced } from "./history-change-once-fixture.ts";

// Guarantee: applying v12 on a live database neither waits for nor blocks Home's writers, and a
// transaction that spans the swap still produces exactly one entry per key.
test("v12 applies under the real runner while a Home write transaction stays open", async () => {
  await homeChangeFixture("v11", true, async ({ b, owner }) => {
    const charge = "INSERT INTO billing_charge(usage_id,amount,user_id) VALUES($1,1,1)";
    await b.query("BEGIN");
    await b.query(charge, [1]);
    // The runner's 500 ms lock timeout would refuse here if any statement waited on that writer.
    await migrateModelHistory(owner);
    await b.query(charge, [2]);
    const swapped = await b.query(
      "SELECT current_setting('basalt.pool_change_memo',true) IS NOT NULL AS swapped",
    );
    assert.equal(swapped.rows[0]!.swapped, true);
    assert.deepEqual((await produced(b)).dirty, [{ pool: pools[0], topic: "pool-readings" }]);
    await b.query("COMMIT");
  });
});

test("v12 holds no lock on any table outside the system catalogs", async () => {
  await homeChangeFixture("v11", true, async ({ owner }) => {
    await owner.query("BEGIN");
    for (const statement of historyChangeOnceStatements) await owner.query(statement);
    const locks = await owner.query(`SELECT c.relname,l.mode FROM pg_locks l
      JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE l.pid=pg_backend_pid() AND n.nspname NOT IN ('pg_catalog','pg_toast')`);
    await owner.query("ROLLBACK");
    assert.deepEqual(locks.rows, []);
  });
});
