import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { projectPoolHistoryChanges } from "../../src/pool/model-history/change-projection.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";
import type { ModelRequest } from "../../src/pool/model-history/record.ts";
import {
  countTriggerStatements,
  historyRows,
  homeChangeFixture,
  insertHistory,
  pools,
  produced,
  type Version,
} from "./history-change-once-fixture.ts";

type Statement = string | [string, unknown[]] | ModelRequest[];
interface Step {
  name: string;
  statements: Statement[];
  end?: "COMMIT" | "ROLLBACK";
}

async function steps(): Promise<Step[]> {
  const [capture, again, saved, retried] = await Promise.all([
    historyRows([pools[0], pools[0], pools[1], null, "app_fixture_once_unmapped"]),
    historyRows([pools[0]]),
    historyRows([pools[1]]),
    historyRows([pools[1]]),
  ]);
  const charge = "INSERT INTO billing_charge(usage_id,amount,user_id,api_key_id) VALUES(1,0,1,1)";
  return [
    {
      name: "one model request's billing transaction",
      statements: [
        'SELECT id FROM "user" WHERE id=1 FOR UPDATE',
        charge,
        'UPDATE "user" SET credits=credits-1,updated_at=now() WHERE id=1',
        "UPDATE billing_charge SET amount=1,matched_price_rule='rule' WHERE usage_id=1",
      ],
    },
    { name: "capture of mapped, unattributed and unmapped rows", statements: [capture, again] },
    {
      name: "unwatched columns only",
      statements: [
        "UPDATE api_key SET last_used_at=now()",
        'UPDATE "user" SET updated_at=now() WHERE id=2',
        "UPDATE quota_snapshot SET lease_until=now()",
        "UPDATE billing_charge SET matched_price_rule='other'",
      ],
    },
    {
      name: "auth bookkeeping only",
      statements: [
        `UPDATE auth SET auth_json=jsonb_set(auth_json,'{model_states,m,updated_at}','"t1"')`,
      ],
    },
    {
      name: "visible auth state",
      statements: [`UPDATE auth SET auth_json=jsonb_set(auth_json,'{status_message}','"cooling"')`],
    },
    { name: "quota reading", statements: ["UPDATE quota_snapshot SET quota_status='limited'"] },
    {
      name: "billing settings with an equal reading, then a changed one",
      statements: [
        `UPDATE kv_store SET value=convert_to('{ "allow_unpriced_models" : true }','UTF8')`,
        `UPDATE kv_store SET value=convert_to('{"allow_unpriced_models":false}','UTF8')`,
      ],
    },
    {
      name: "other key-value rows",
      statements: [
        `INSERT INTO kv_store VALUES('session:1','\\x01') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
        `INSERT INTO kv_store VALUES('session:1','\\x02') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
        "DELETE FROM kv_store WHERE key='session:1'",
      ],
    },
    { name: "key fields", statements: ["UPDATE api_key SET display_name='renamed'"] },
    {
      name: "membership",
      statements: [
        "INSERT INTO channel_group_detail VALUES(3,2,'acct-a',NULL)",
        "UPDATE channel_group_detail SET deleted_at=now() WHERE id=3",
      ],
    },
    {
      name: "global rows",
      statements: [
        "INSERT INTO model_group VALUES(1,'group',false,NULL)",
        "UPDATE model_group SET disabled=true",
      ],
    },
    {
      name: "user moves to another pool",
      statements: [
        ['UPDATE "user" SET username=$1 WHERE id=1', [await backendUserName("moved", pools[1])]],
      ],
    },
    {
      name: "rolled back",
      statements: [charge, "UPDATE quota_snapshot SET quota_status='ok'"],
      end: "ROLLBACK",
    },
    {
      // The first bump of each pool is undone with its savepoint; the retry must bump again.
      name: "savepoint rolled back, then retried",
      statements: [
        "SAVEPOINT retry",
        "INSERT INTO billing_charge(usage_id,amount,user_id) VALUES(2,1,2)",
        saved,
        "ROLLBACK TO SAVEPOINT retry",
        "INSERT INTO billing_charge(usage_id,amount,user_id) VALUES(3,1,2)",
        retried,
      ],
    },
    {
      name: "pool groups",
      statements: [
        "UPDATE channel_group SET disabled=true WHERE id=1",
        "UPDATE channel_group SET channel_name='signalbox-pool-app_fixture_once_c' WHERE id=2",
        "DELETE FROM channel_group WHERE id=3",
      ],
    },
    {
      name: "deletes",
      statements: [
        "DELETE FROM billing_charge",
        "DELETE FROM api_key",
        'DELETE FROM "user" WHERE id=2',
        "DELETE FROM auth WHERE uuid='acct-b'",
      ],
    },
  ];
}

async function run(client: pg.Client, statement: Statement) {
  if (typeof statement === "string") return client.query(statement);
  if (typeof statement[0] === "string")
    return client.query(statement[0], statement[1] as unknown[]);
  return insertHistory(client, statement as ModelRequest[]);
}

async function replay(version: Version, journal: boolean, script: readonly Step[], home = true) {
  return homeChangeFixture(
    version,
    journal,
    async ({ a }) => {
      const observed = [];
      for (const step of script) {
        await a.query("BEGIN");
        for (const statement of step.statements) await run(a, statement);
        const inside = await produced(a);
        await a.query(step.end ?? "COMMIT");
        observed.push({ step: step.name, inside, after: (await produced(a)).heads });
      }
      return observed;
    },
    home,
  );
}

// Guarantee: every committed change still produces exactly the legacy entries, and a rollback
// (whole or to a savepoint) still leaves none. Prepared journals also keep every legacy revision.
for (const journal of [true, false])
  test(`every watcher mode produces v11's entries per transaction with journal ${journal ? "active" : "prepared"}`, async () => {
    const script = await steps();
    const legacy = await replay("v11", journal, script);
    const current = await replay("v12", journal, script);
    assert.deepEqual(current, legacy);
    // Not vacuous: the request, capture and savepoint retry each produce entries.
    const keys = (index: number) =>
      journal ? legacy[index]!.inside.dirty : legacy[index]!.inside.heads;
    assert.ok(journal ? keys(0).length === 1 : keys(0).some((row) => row.revision > 0));
    if (journal) {
      assert.deepEqual(keys(1), [
        { pool: pools[0], topic: "pool-usage" },
        { pool: pools[1], topic: "pool-usage" },
      ]);
      assert.deepEqual(keys(2), []);
      assert.deepEqual(keys(3), []);
      assert.deepEqual(keys(13), [
        { pool: pools[1], topic: "pool-readings" },
        { pool: pools[1], topic: "pool-usage" },
      ]);
    }
  });

// Guarantee: history databases without Home tables resolve through registered heads alone.
for (const journal of [true, false])
  test(`Home-less history produces v11's entries with journal ${journal ? "active" : "prepared"}`, async () => {
    const [first, second, saved] = await Promise.all([
      historyRows([pools[0], pools[1], null, "app_fixture_once_unmapped", pools[0]]),
      historyRows([pools[0], pools[1]]),
      historyRows([pools[1]]),
    ]);
    const script: Step[] = [
      { name: "two statements", statements: [first, second] },
      {
        name: "savepoint",
        statements: [
          "SAVEPOINT s",
          saved,
          "ROLLBACK TO SAVEPOINT s",
          await historyRows([pools[1]]),
        ],
      },
      { name: "rolled back", statements: [await historyRows([pools[0]])], end: "ROLLBACK" },
    ];
    const legacy = await replay("v11", journal, script, false);
    assert.deepEqual(await replay("v12", journal, script, false), legacy);
    if (journal)
      assert.deepEqual(legacy[0]!.inside.dirty, [
        { pool: pools[0], topic: "pool-usage" },
        { pool: pools[1], topic: "pool-usage" },
      ]);
  });

// Measurement: executor statements run inside the triggers (top-level statements excluded).
test("one model request and one bulk import chunk run far fewer trigger statements", async (t) => {
  const request = await historyRows([pools[0]]);
  const chunk = await historyRows(Array.from({ length: 5000 }, () => pools[0]));
  const counts: Record<
    string,
    {
      request: number;
      projection: number;
      registration: number;
      bulk: number;
      requestKeys: unknown;
    }
  > = {};
  for (const version of ["v11", "v12"] as const)
    await homeChangeFixture(version, true, async ({ a }) => {
      const counter = await countTriggerStatements(a);
      const db = counter.measured;
      await db.query("BEGIN");
      await db.query('SELECT id FROM "user" WHERE id=1 FOR UPDATE');
      await db.query(
        "INSERT INTO billing_charge(usage_id,amount,user_id,api_key_id) VALUES(1,0,1,1)",
      );
      await db.query('UPDATE "user" SET credits=credits-1,updated_at=now() WHERE id=1');
      await db.query("UPDATE billing_charge SET amount=1 WHERE usage_id=1");
      const billing = (await produced(db)).dirty;
      await db.query("COMMIT");
      await db.query("BEGIN");
      await insertHistory(db, request);
      const capture = (await produced(db)).dirty;
      await db.query("COMMIT");
      const requestStatements = counter.take();
      while ((await projectPoolHistoryChanges(db)) > 0);
      const projection = counter.take();
      await readPoolHistoryChanges(db, "app_fixture_once_first_read");
      const registration = counter.take();
      await db.query("BEGIN");
      await insertBulkRequests(db, chunk);
      await db.query("COMMIT");
      counts[version] = {
        request: requestStatements,
        projection,
        registration,
        bulk: counter.take(),
        requestKeys: [billing, capture],
      };
    });
  t.diagnostic(`trigger statements ${JSON.stringify(counts)}`);
  assert.deepEqual(counts.v12!.requestKeys, counts.v11!.requestKeys);
  // v11: 7 per resolved row plus the commit notification. v12: the charge resolves once (1 query,
  // 2 journal inserts), its update looks up the user only, the credit update skips, capture
  // resolves once, plus the two commit notifications. The 5000-row chunk resolves once.
  // Every heads index write (a first registration here, non-HOT projection updates in production)
  // evaluated the SQL hash as its own statement; projection itself is unchanged.
  const measured = (version: Version) => {
    const { request, projection, registration, bulk } = counts[version]!;
    return { request, projection, registration, bulk };
  };
  assert.deepEqual(
    { v11: measured("v11"), v12: measured("v12") },
    {
      v11: { request: 34, projection: 11, registration: 4, bulk: 35001 },
      v12: { request: 9, projection: 11, registration: 2, bulk: 4 },
    },
  );
});

// Guarantee: the skip is per transaction. Concurrent transactions and a stale session value
// each still produce their own entry, so every committed transaction advances the revision.
test("concurrent transactions and a stale session memo each produce their own entry", async () => {
  await homeChangeFixture("v12", true, async ({ a, b, owner }) => {
    const charge = "INSERT INTO billing_charge(usage_id,amount,user_id) VALUES(1,1,1)";
    await a.query("BEGIN");
    await a.query(charge);
    await b.query("BEGIN");
    await b.query(charge);
    const memo = (await a.query("SELECT current_setting('basalt.pool_change_memo') AS memo"))
      .rows[0]!.memo;
    assert.deepEqual((await produced(b)).dirty, [{ pool: pools[0], topic: "pool-readings" }]);
    await b.query("COMMIT");
    await a.query("COMMIT");
    await a.query("SELECT set_config('basalt.pool_change_memo',$1,false)", [memo]);
    await a.query("BEGIN");
    await a.query(charge);
    assert.deepEqual((await produced(a)).dirty, [{ pool: pools[0], topic: "pool-readings" }]);
    await a.query("COMMIT");
    while ((await projectPoolHistoryChanges(owner)) > 0);
    const head = await owner.query(
      "SELECT revision::int FROM basalt_pool_change_heads WHERE pool=$1 AND topic='pool-readings'",
      [pools[0]],
    );
    assert.equal(head.rows[0]!.revision, 3);
  });
});

// Guarantee: retained index entries still match. The replaced hash returns the writers' digest.
test("the replaced history hash returns the same 16 hex digits as before and as writers", async () => {
  const inputs = ["app_a", "app_ü-ß", "app_quote'\\back", `app_${"x".repeat(252)}`, ""];
  const hashes = (version: Version) =>
    homeChangeFixture(version, false, async ({ owner }) =>
      (
        await owner.query(
          "SELECT basalt_pool_history_hash(v) AS hash FROM unnest($1::text[]) WITH ORDINALITY u(v,n) ORDER BY n",
          [inputs],
        )
      ).rows.map((row) => row.hash),
    );
  const legacy = await hashes("v11");
  assert.deepEqual(await hashes("v12"), legacy);
  assert.deepEqual(
    legacy,
    await Promise.all(inputs.map(async (input) => (await digest(input)).slice(0, 16))),
  );
});
