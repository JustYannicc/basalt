import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { parseUsageImport } from "../../src/pool/model-history/import.ts";
import {
  historySchemaMigrations,
  historySchemaVersion,
} from "../../src/pool/model-history/schema.ts";
import {
  existingRequests,
  insertRequests,
  HistoryConflict,
} from "../../src/pool/model-history/store.ts";

test("external import rejects changed retained contents and conflicting duplicate IDs", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE basalt_model_history_migrations(name text PRIMARY KEY)");
    for (const migration of historySchemaMigrations)
      for (const sql of migration.statements) await db.exec(sql);
    await db.query("INSERT INTO basalt_model_history_migrations VALUES ($1)", [
      historySchemaVersion,
    ]);
    const parsed = await parseUsageImport(
      {
        source: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        format: "cpamp-v1-jsonl",
        data: JSON.stringify({
          event_hash: "a".repeat(64),
          failed: false,
          timestamp: "2026-05-05T11:32:18.619000001Z",
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          provider: "fixture",
          model: "fixture",
        }),
      },
      { pool: "pool", person: "person" },
    );
    const row = parsed.records[0]!;
    let inserts = 0;
    const adapter = {
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("INSERT INTO basalt_model_requests")) inserts++;
        const result = await db.query<Record<string, unknown>>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? null };
      },
    };
    assert.equal(await insertRequests(adapter, [row], false, true), 1);
    assert.equal(await insertRequests(adapter, [row], false, true), 0);
    assert.equal(inserts, 1, "a retained batch never reissues INSERT");
    await assert.rejects(
      insertRequests(adapter, [{ ...row, appId: "fixture-app" }]),
      /App model attribution migration is not ready/,
    );
    for (const changed of [
      { inputTokens: "101" },
      { timestamp: "2026-05-05T11:32:18.619000002Z" },
      { failed: true },
      { model: "changed" },
      { cost: "1", currency: "USD", costBasis: "historical-api-price" as const },
      { person: "changed" },
      { appId: "changed" },
    ]) {
      await assert.rejects(
        existingRequests(adapter, [{ ...row, ...changed }], false, true),
        HistoryConflict,
      );
    }
    const other = { ...row, id: "b".repeat(64), sourceRecord: "c".repeat(64) };
    await assert.rejects(
      insertRequests(adapter, [other, { ...other, totalTokens: "999" }], false, true),
      HistoryConflict,
    );
    assert.equal(
      (await db.query<{ n: string }>("SELECT count(*)::text AS n FROM basalt_model_requests"))
        .rows[0]!.n,
      "1",
    );
  } finally {
    await db.close();
  }
});
