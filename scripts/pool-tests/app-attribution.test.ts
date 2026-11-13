import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { appModelLabel } from "../../src/pool/app-model-contract.ts";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { appUsage } from "../../src/pool/model-history/app-usage.ts";
import { activateHomeBackfill, planHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import {
  appAttributionReady,
  historyBaseSchemaVersion,
  historySchemaStatements,
  historyAppSchemaVersion,
  historyAccountTimeSchemaVersion,
  historyTrafficSchemaVersion,
  historySchemaVersion,
  historyTrafficSchemaVersion,
  migrateModelHistory,
  type HistoryDatabase,
} from "../../src/pool/model-history/schema.ts";
import { readRequests } from "../../src/pool/model-history/store.ts";
import { homeMetadataFixture, historyMemoryOwnerFixture } from "./history-fixture.ts";

const app = "app_11111111-1111-4111-8111-111111111111";
test("app attribution upgrades additively and new Home attempts retain app person usage and exact billing in one row", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    await historyMemoryOwnerFixture(db);
    await homeMetadataFixture(db);
    await db.query(
      `CREATE TABLE basalt_model_history_migrations (name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    );
    for (const sql of historySchemaStatements) await db.query(sql);
    await db.query("INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", [
      historyBaseSchemaVersion,
    ]);
    assert.equal(await appAttributionReady(db), false);
    await db.query('INSERT INTO "user" VALUES (1,$1)', [await backendUserName("person", "pool")]);
    await db.query("INSERT INTO api_key VALUES (1,$1,1,NULL)", [`sha256:${"a".repeat(64)}`]);
    const add = (id: number, fingerprint: string) =>
      db.query(
        `INSERT INTO usage
      (id,timestamp,request_id,api_key,auth_index,provider,model,endpoint)
      VALUES ($1,'2026-11-02T12:00:00Z',$2,$3,'fixture-account','fixture-provider','fixture-model','/v1/chat/completions')`,
        [id, `attempt-${id}`, `sha256:${fingerprint}`],
      );
    await add(1, "a".repeat(64));
    await activateHomeBackfill(db, await planHomeBackfill(db));
    await captureHomeRequests(db);
    const query = {
      pool: (await digest("pool")).slice(0, 16),
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-03T00:00:00Z",
    };
    const old = (await readRequests(db, query)).records[0];
    assert.ok(old);
    assert.equal(old.app_id, null);
    assert.equal(old.requirement, null);
    await migrateModelHistory(db);
    await migrateModelHistory(db);
    assert.equal(await appAttributionReady(db), true);
    assert.deepEqual(
      (await db.query("SELECT name FROM basalt_model_history_migrations ORDER BY name")).rows.map(
        (row) => row.name,
      ),
      [
        historyBaseSchemaVersion,
        historyAppSchemaVersion,
        historyAccountTimeSchemaVersion,
        historyTrafficSchemaVersion,
        historySchemaVersion,
      ],
    );
    assert.deepEqual(
      (await readRequests(db, query)).records[0],
      old,
      "the old usage row is unchanged",
    );
    const label = appModelLabel(app, "email", "11111111-1111-4111-8111-111111111111");
    await db.query("INSERT INTO api_key VALUES (2,$1,1,$2)", [`sha256:${"b".repeat(64)}`, label]);
    await add(2, "b".repeat(64));
    await db.query(`INSERT INTO billing_charge (id,usage_id,amount,matched_price_rule,price_snapshot,api_key_id,user_id)
      VALUES ('charge-two',2,0.125,'fixture-price','{"input_price_per_million":1,"output_price_per_million":2,"cache_read_price_per_million":0,"cache_write_price_per_million":0,"request_price":0,"matched_service_tier":"*","min_input_tokens":0}',2,1)`);
    // An ordinary private key label is never selected as app metadata.
    await db.query("INSERT INTO api_key VALUES (3,$1,1,'private-label-sentinel')", [
      `sha256:${"c".repeat(64)}`,
    ]);
    await add(3, "c".repeat(64));
    // Home's management DELETE soft-deletes APIKeyRecord. Capture must still find its metadata.
    await db.query("ALTER TABLE api_key ADD COLUMN deleted_at timestamptz");
    await db.query("UPDATE api_key SET deleted_at = CURRENT_TIMESTAMP WHERE id = 2");
    await captureHomeRequests(db);
    await captureHomeRequests(db);
    const rows = (await readRequests(db, query)).records;
    assert.equal(rows.length, 3, "the app request does not create a second usage event");
    const current = rows.find((row) => row.request_id === "attempt-2");
    assert.ok(current);
    assert.equal(current.app_id, app);
    assert.equal(current.requirement, "email");
    assert.equal(current.person, await digest("person"));
    assert.equal(current.cost, "0.125000000000");
    assert.equal(current.cost_basis, "home-charge");
    assert.equal(current.total_tokens, "110");
    assert.equal(rows.find((row) => row.request_id === "attempt-3")?.app_id, null);
    assert.equal(JSON.stringify(rows).includes("private-label-sentinel"), false);
    const usage = await appUsage(db, {
      pool: "pool",
      members: ["person", "unrelated-person"],
      from: query.from,
      to: query.to,
    });
    assert.deepEqual(
      usage?.get("person")?.map((row) => [row.app, row.requirement, row.requests, row.cost]),
      [
        [app, "email", 1, 0.125],
        [null, null, 2, 0],
      ],
    );
    assert.equal(usage?.has("unrelated-person"), false);
    assert.equal(
      (
        await appUsage(db, {
          pool: "foreign-pool",
          members: ["person"],
          from: query.from,
          to: query.to,
        })
      )?.size,
      0,
    );
    await assert.rejects(
      db.query("UPDATE basalt_model_requests SET app_id=$1 WHERE request_id='attempt-1'", [app]),
      /append only/,
    );
  } finally {
    await database.close();
  }
});
