import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import { recordGatewayRefusal } from "../../src/pool/model-history/gateway.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";

test("a gateway refusal appears once in activated history with no fabricated usage or charge", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = { query: async (text, values) => {
    const result = await database.query<Record<string, unknown>>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  } };
  try {
    await migrateModelHistory(db);
    const input = { requestId: crypto.randomUUID(), at: "2026-10-31T12:00:00.000Z", pool: "pool-a",
      person: await digest("person"), keyId: 1, pathname: "/v1/responses", latencyMs: 4.6 };
    await recordGatewayRefusal(db, input);
    assert.equal((await db.query("SELECT * FROM basalt_model_requests")).rows.length, 0);
    await db.query(`INSERT INTO basalt_model_history_cursor (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id)
      VALUES ($1,0,0,0,true,0)`, ["a".repeat(64)]);
    await recordGatewayRefusal(db, input);
    await recordGatewayRefusal(db, input);
    const rows = (await db.query("SELECT * FROM basalt_model_requests")).rows;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.pool, (await digest("pool-a")).slice(0, 16));
    assert.equal(row.person, input.person);
    assert.equal(row.request_id, input.requestId);
    assert.equal(row.status_code, 503);
    assert.equal(row.failed, true);
    assert.equal(row.api_type, "pool-protection-unavailable");
    for (const field of ["input_tokens", "output_tokens", "total_tokens", "cost", "currency", "model", "provider"])
      assert.equal(row[field], null, field);
  } finally { await database.close(); }
});
