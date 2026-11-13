import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { seriesFixture } from "./series-fixture.ts";
import {
  insertBulkRequests,
  historyBulkBatchSize,
} from "../../src/pool/model-history/bulk-store.ts";
import { parseUsageImport } from "../../src/pool/model-history/import.ts";
import type { ModelRequest } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  existingRequests,
  HistoryConflict,
  insertRequests,
  readRequests,
} from "../../src/pool/model-history/store.ts";

async function sample() {
  const data = Array.from({ length: 417 }, (_, i) =>
    JSON.stringify({
      event_hash: i.toString(16).padStart(64, "0"),
      failed: i % 3 === 0,
      status_code: i % 3 === 0 ? 429 : 200,
      timestamp: `2026-01-01T00:45:00.${String(i).padStart(9, "0")}Z`,
      input_tokens: "9007199254740993",
      output_tokens: i,
      cache_read_tokens: 20,
      cache_write_tokens: 0,
      reasoning_tokens: 3,
      total_tokens: String(9007199254740993n + BigInt(i)),
      latency_ms: i * 10,
      provider: "fixture-provider",
      model: i % 2 ? "fixture-model" : null,
      endpoint: "/v1/responses",
      account_ref: `fixture-account-${i % 3}`,
      client_key_ref: "fixture-key",
      request_id: `fixture-request-${i}`,
      service_tier: "priority",
    }),
  ).join("\n");
  const records: ModelRequest[] = [];
  for (let offset = 0; offset < 417; offset += 200) {
    const parsed = await parseUsageImport(
      { source: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", format: "cpamp-v1-jsonl", data, offset },
      { pool: "fixture-pool", person: "fixture-owner" },
    );
    records.push(...parsed.records);
  }
  return records;
}

const retainedRows = async (db: HistoryDatabase) =>
  (
    await db.query(
      "SELECT to_jsonb(r)-'ingested_at' AS row FROM basalt_model_requests r ORDER BY id",
    )
  ).rows;

test("bulk history stores the same parsed rows as legacy pages and preserves their public limits", async () => {
  await seriesFixture(async ({ db }) => {
    const records = await sample();
    records[0] = {
      ...records[0]!,
      appId: "fixture-app",
      requirement: "fixture-model-access",
      cost: "0.000000000123",
      currency: "USD",
      costBasis: "historical-api-price",
      priceVersion: "a".repeat(64),
      originalPriceRule: "fixture-price",
      price: {
        input: "1.000000000000",
        output: "2.000000000000",
        cacheRead: "0.500000000000",
        cacheWrite: "1.250000000000",
        request: "0.000000000000",
        tier: "priority",
        minInput: "0",
        validFrom: "2025-01-01T00:00:00.000000000Z",
        validTo: null,
        billing: {
          matchedRule: "fixture-price",
          provider: "fixture-provider",
          model: "fixture-model",
          requestedTier: "priority",
          responseTier: "flex",
          tierSource: "response",
          effectiveTier: "flex",
          responseFallback: false,
        },
      },
    };
    await db.query("BEGIN");
    for (let offset = 0; offset < records.length; offset += 200)
      assert.equal(
        await insertRequests(db, records.slice(offset, offset + 200), false, true),
        Math.min(200, records.length - offset),
      );
    const expected = await retainedRows(db);
    await db.query("ROLLBACK");
    assert.deepEqual(await retainedRows(db), []);
    await db.query("BEGIN");
    assert.deepEqual(await insertBulkRequests(db, [...records, records[0]!]), {
      inserted: 417,
      existing: 0,
      count: 417,
    });
    assert.deepEqual(await retainedRows(db), expected);
    await db.query("COMMIT");
    assert.deepEqual(await insertBulkRequests(db, records), {
      inserted: 0,
      existing: 417,
      count: 417,
    });
    assert.deepEqual(await retainedRows(db), expected);
    await assert.rejects(insertRequests(db, records.slice(0, 201)), /batch exceeds its limit/);
    await assert.rejects(existingRequests(db, records.slice(0, 201)), /batch exceeds its limit/);
    const page = await readRequests(db, {
      pool: records[0]!.pool!,
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
    });
    assert.equal(page.records.length, 200);
    assert.ok(page.next);
  });
});

test("bulk history dedupes identical IDs and rejects changed content or ownership", async () => {
  await seriesFixture(async ({ db, row }) => {
    const saved = await row({ appId: "fixture-app" });
    const records = Array.from({ length: historyBulkBatchSize }, () => saved);
    assert.deepEqual(await insertBulkRequests(db, records), { inserted: 1, existing: 0, count: 1 });
    assert.deepEqual(await insertBulkRequests(db, records), { inserted: 0, existing: 1, count: 1 });
    await assert.rejects(
      insertBulkRequests(db, [...records, saved]),
      /bulk batch exceeds its limit/,
    );
    const before = await retainedRows(db);
    for (const change of [
      { source: "a".repeat(64) },
      { sourceRecord: "b".repeat(64) },
      { pool: "a".repeat(16) },
      { person: "c".repeat(64) },
      { account: "d".repeat(64) },
      { appId: "changed-app" },
      { requirement: "changed-access" },
      { timestamp: "2026-01-01T00:45:00.000000001Z" },
      { inputTokens: "999" },
      { failed: true },
      { model: "changed-model" },
    ]) {
      const changed = { ...saved, ...change };
      await assert.rejects(insertBulkRequests(db, [changed]), HistoryConflict);
      await assert.rejects(insertBulkRequests(db, [saved, changed]), HistoryConflict);
    }
    assert.deepEqual(await retainedRows(db), before);
    const fresh = await row();
    await assert.rejects(
      insertBulkRequests(db, [fresh, { ...fresh, totalTokens: "999" }]),
      HistoryConflict,
    );
    assert.deepEqual(await retainedRows(db), before);
    assert.deepEqual(await insertBulkRequests(db, []), { inserted: 0, existing: 0, count: 0 });
  });
});

test("bulk history keeps base-schema imports working and refuses unavailable app attribution", async () => {
  await seriesFixture(async ({ db, row }) => {
    await db.query(
      "DELETE FROM basalt_model_history_migrations WHERE name='model_request_history_v2_app_attribution'",
    );
    await db.query("ALTER TABLE basalt_model_requests DROP COLUMN app_id, DROP COLUMN requirement");
    const record = await row();
    assert.deepEqual(await insertBulkRequests(db, [record]), {
      inserted: 1,
      existing: 0,
      count: 1,
    });
    assert.deepEqual(await insertBulkRequests(db, [record]), {
      inserted: 0,
      existing: 1,
      count: 1,
    });
    await assert.rejects(
      insertBulkRequests(db, [{ ...record, appId: "fixture-app" }]),
      HistoryConflict,
    );
  });
});

for (const changed of [false, true]) {
  const outcome = changed
    ? "refuse changed retained content and roll back"
    : "count overlapping IDs once";
  test(`concurrent bulk chunks ${outcome}`, async () => {
    await seriesFixture(async ({ db, schema, row }) => {
      const other = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL });
      await other.connect();
      try {
        await other.query(`SET search_path TO ${schema}`);
        const shared = await row({ id: "f".repeat(64) });
        const fresh = await row({ id: "0".repeat(64) });
        await db.query("BEGIN");
        await insertBulkRequests(db, [shared]);
        await other.query("BEGIN");
        let insertionStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          insertionStarted = resolve;
        });
        const adapter: HistoryDatabase = {
          query: (text, values) => {
            const pending = other.query(text, values);
            if (text.startsWith("INSERT INTO basalt_model_requests")) insertionStarted();
            return pending;
          },
        };
        const incoming = changed ? { ...shared, person: "c".repeat(64) } : shared;
        const pending = insertBulkRequests(adapter, [incoming, fresh]);
        const settled = pending.then(
          (result) => ({ result, error: null }),
          (error: unknown) => ({ result: null, error }),
        );
        // The second chunk has finished its precheck and sent INSERT while the first is uncommitted.
        await Promise.race([
          started,
          settled.then(({ error }) => {
            throw error ?? new Error("The concurrent chunk returned before INSERT");
          }),
        ]);
        await db.query("COMMIT");
        const outcome = await settled;
        if (changed) {
          assert.ok(outcome.error instanceof HistoryConflict);
          await other.query("ROLLBACK");
          assert.equal(
            (await retainedRows(db)).length,
            1,
            "the caller rolls back the fresh row too",
          );
        } else {
          assert.equal(outcome.error, null);
          assert.deepEqual(outcome.result, { inserted: 1, existing: 1, count: 2 });
          await other.query("COMMIT");
          assert.equal((await retainedRows(db)).length, 2);
          assert.deepEqual(await insertBulkRequests(db, [fresh, shared]), {
            inserted: 0,
            existing: 2,
            count: 2,
          });
        }
      } finally {
        await other.query("ROLLBACK").catch(() => {});
        await other.end();
      }
    });
  });
}
