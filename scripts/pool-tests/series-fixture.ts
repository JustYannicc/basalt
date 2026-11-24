import { historySchemaFixture } from "./history-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { digest } from "../../src/pool/backend-users.ts";
import { reference, timestamp, type ModelRequest } from "../../src/pool/model-history/record.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { insertRequests } from "../../src/pool/model-history/store.ts";
import { historyUsagePeopleRollupVersion } from "../../src/pool/model-history/usage-rollup-people-schema.ts";
import type {
  PoolUsageSeriesInput,
  SeriesAuthority,
  SeriesBucket,
} from "../../src/pool/model-history/series-contract.ts";

export const pool = "series-fixture";
export const input: PoolUsageSeriesInput = {
  pool,
  from: "2026-01-01T00:00:00Z",
  to: "2026-01-02T00:00:00Z",
  bucket: "hour",
  by: [],
};
export const authority: SeriesAuthority = { canManage: true, mappingProven: false, accounts: [] };
export const full = (value: unknown): SeriesBucket => {
  assert.ok(typeof value === "object" && value !== null && "tokens" in value);
  return value as SeriesBucket;
};

/** A real, isolated Postgres schema. Never accept a non-loopback database URL. */
export async function seriesFixture(
  work: (fixture: {
    db: HistoryDatabase;
    schema: string;
    client: pg.Client;
    row: (overrides?: Partial<ModelRequest>) => Promise<ModelRequest>;
    insert: (...rows: Partial<ModelRequest>[]) => Promise<ModelRequest[]>;
  }) => Promise<void>,
) {
  const url = process.env.POOL_TEST_ADMIN_URL;
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
    throw new Error("POOL_TEST_ADMIN_URL must point to isolated local test Postgres");
  const schema = `series_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await historySchemaFixture(client, schema);
    await client.query(`SET search_path TO ${schema}`);
    const db: HistoryDatabase = client;
    await migrateModelHistory(db);
    let sequence = 0;
    const source = await digest("fixture-import");
    const poolId = (await digest(pool)).slice(0, 16);
    // Keyed as every writer keys a request: the digest of its final source and record.
    const row = async (overrides: Partial<ModelRequest> = {}): Promise<ModelRequest> => {
      const recordOf = overrides.sourceRecord ?? (await digest(String(++sequence)));
      const sourceOf = overrides.source ?? source;
      return {
        id: await digest(JSON.stringify([sourceOf, recordOf])),
        source,
        sourceRecord: recordOf,
        timestamp: timestamp("2026-01-01T00:45:00Z"),
        pool: poolId,
        person: null,
        account: null,
        clientKey: null,
        requestId: null,
        provider: null,
        model: null,
        endpoint: null,
        apiType: null,
        serviceTier: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        tokenQuality: "unclassified",
        latencyMs: null,
        failed: false,
        statusCode: null,
        cost: null,
        currency: null,
        costBasis: "unpriced",
        priceVersion: null,
        originalPriceRule: null,
        price: null,
        attribution: "unknown",
        ...overrides,
      };
    };
    const insert = async (...overrides: Partial<ModelRequest>[]) => {
      const rows = await Promise.all(overrides.map(row));
      await insertRequests(db, rows);
      return rows;
    };
    await work({ db, schema, client, row, insert });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  }
}

export async function accountAuthority() {
  const source = await digest("home-local-v1");
  const visible = (await reference(source, "account", "current-credential"))!;
  const hidden = (await reference(source, "account", "private-credential"))!;
  // This simulates a trusted host whose pinned mapping fixture passed. It is not the live proof.
  const authority: SeriesAuthority = {
    canManage: true,
    mappingProven: true,
    accounts: [
      { account: "saved-visible", history: [visible] },
      { account: null, history: [hidden] },
    ],
  };
  return { source, visible, hidden, authority };
}

/**
 * A database as history migration v15 left it: v16's trigger, functions and tables dropped and its
 * step unrecorded, so a test proves v15's own backfill, or applies v16 to existing history.
 */
export async function withoutPeopleRollup(db: HistoryDatabase) {
  await db.query("DROP TRIGGER basalt_model_usage_people_rollup ON basalt_model_requests");
  await db.query(`DROP FUNCTION basalt_model_usage_people_rollup(),
    basalt_model_usage_people_recompute(varchar,timestamptz,timestamptz),
    basalt_model_usage_people_apply(varchar,timestamptz,bigint,jsonb)`);
  await db.query(`DROP TABLE basalt_model_usage_people_hourly, basalt_model_usage_people_hours,
    basalt_model_usage_people_ready`);
  await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
    historyUsagePeopleRollupVersion,
  ]);
}

/** The series fixture without v16, for the tests of v15's own backfill and tick. */
export const v15Fixture = (work: Parameters<typeof seriesFixture>[0]) =>
  seriesFixture(async (f) => {
    await withoutPeopleRollup(f.db);
    await work(f);
  });
