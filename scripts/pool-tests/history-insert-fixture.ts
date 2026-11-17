import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { digest } from "../../src/pool/backend-users.ts";
import { parseBulkUsageImport } from "../../src/pool/model-history/import.ts";
import {
  historySchemaMigrations,
  activateModelHistoryJournal,
} from "../../src/pool/model-history/schema.ts";
import { historyRecordLayout, recordValues } from "../../src/pool/model-history/store.ts";
import type { ModelRequest } from "../../src/pool/model-history/record.ts";
import { historySchemaFixture } from "./history-fixture.ts";

export const rowVersion = "model_request_history_v11_indexed_row_invalidation";
export const insertPools = [
  "app_fixture_history_a",
  "app_fixture_history_b",
  "app_fixture_head_only",
];

/** Retained pre-v11 state, with independent writers and a real READ COMMITTED observer. */
export async function historyInsertFixture<T>(
  work: (fixture: {
    a: pg.Client;
    b: pg.Client;
    reader: pg.Client;
    rows: (pools: readonly (string | null)[]) => Promise<ModelRequest[]>;
    insert: (
      client: pg.Client,
      rows: readonly ModelRequest[],
      table?: string,
    ) => Promise<pg.QueryResult>;
    instrumentTriggers: () => Promise<void>;
  }) => Promise<T>,
  journal = true,
) {
  const url = process.env.POOL_TEST_ADMIN_URL;
  assert.ok(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname));
  const schema = `history_insert_${randomUUID().replaceAll("-", "")}`;
  const a = new pg.Client({ connectionString: url });
  const b = new pg.Client({ connectionString: url });
  const reader = new pg.Client({ connectionString: url });
  const clients = [a, b, reader];
  await Promise.all(clients.map((client) => client.connect()));
  try {
    await historySchemaFixture(a, schema);
    for (const client of clients) {
      await client.query(`SET search_path TO ${schema}`);
      await client.query("SET ROLE basalt_pool_owner");
    }
    await a.query(`CREATE TABLE channel_group(id bigint PRIMARY KEY,channel_name text,
      disabled boolean DEFAULT false,deleted_at timestamptz);
      CREATE TABLE channel_group_detail(id bigint PRIMARY KEY,channel_group_id bigint,
        auth_id text,deleted_at timestamptz);
      CREATE TABLE basalt_model_history_migrations(name text PRIMARY KEY,
        completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    for (const migration of historySchemaMigrations.filter((item) => item.name !== rowVersion)) {
      for (const statement of migration.statements) await a.query(statement);
      await a.query("INSERT INTO basalt_model_history_migrations(name) VALUES($1)", [
        migration.name,
      ]);
    }
    await a.query("INSERT INTO channel_group VALUES(1,$1,false,NULL),(2,$2,false,NULL)", [
      `signalbox-pool-${insertPools[0]}`,
      `signalbox-pool-${insertPools[1]}`,
    ]);
    await a.query("INSERT INTO basalt_pool_change_heads VALUES($1,'pool-usage',0)", [
      insertPools[2],
    ]);
    await a.query("TRUNCATE basalt_pool_change_pending");
    if (journal) await activateModelHistoryJournal(a);
    await a.query(`CREATE TABLE fixture_invalidations(pool text,topic text);
      CREATE TABLE fixture_trigger_calls(level text);
      CREATE TABLE fixture_write_calls(name text);
      CREATE FUNCTION fixture_record_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO fixture_write_calls VALUES(TG_TABLE_NAME); RETURN NULL; END $$;
      CREATE TRIGGER fixture_dirty AFTER INSERT ON basalt_pool_change_dirty FOR EACH STATEMENT
        EXECUTE FUNCTION fixture_record_write();
      CREATE TRIGGER fixture_batch AFTER INSERT ON basalt_pool_change_batches FOR EACH STATEMENT
        EXECUTE FUNCTION fixture_record_write()`);
    const change = (
      await a.query(
        "SELECT pg_get_functiondef('basalt_pool_change(text,text)'::regprocedure) AS sql",
      )
    ).rows[0].sql;
    await a.query(
      change.replace(
        /BEGIN/i,
        "BEGIN INSERT INTO fixture_invalidations VALUES(pool_id,change_topic);",
      ),
    );
    const instrumentTriggers = async () => {
      for (const name of ["basalt_pool_record_change"]) {
        const found = await a.query("SELECT pg_get_functiondef(to_regprocedure($1)) AS sql", [
          `${name}()`,
        ]);
        const sql = found.rows[0]?.sql;
        if (sql && !sql.includes("fixture_trigger_calls"))
          await a.query(
            sql.replace(
              /BEGIN/i,
              "BEGIN IF TG_ARGV[0]='history' THEN INSERT INTO fixture_trigger_calls VALUES(TG_LEVEL); END IF;",
            ),
          );
      }
    };
    await instrumentTriggers();
    let sequence = 0;
    const rows = async (pools: readonly (string | null)[]) => {
      const data = (
        await Promise.all(
          pools.map(async () =>
            JSON.stringify({
              event_hash: await digest(String(++sequence)),
              timestamp: "2026-01-01T00:00:00Z",
              failed: false,
            }),
          ),
        )
      ).join("\n");
      const parsed = await parseBulkUsageImport(
        {
          source: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          format: "cpamp-v1-jsonl",
          data,
        },
        { pool: insertPools[0]!, person: "fixture-owner" },
      );
      return Promise.all(
        parsed.records.map(async (row, index) => ({
          ...row,
          pool: pools[index] === null ? null : (await digest(pools[index]!)).slice(0, 16),
        })),
      );
    };
    const insert = (
      client: pg.Client,
      rows: readonly ModelRequest[],
      table = "basalt_model_requests",
    ) => {
      assert.match(table, /^basalt_model_requests(?:_(?:[0-9]|1[0-5]))?$/);
      const { selected, types } = historyRecordLayout(true);
      return client.query(
        `INSERT INTO ${table} (${selected}) SELECT ${selected}
        FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
        ON CONFLICT(id) DO NOTHING RETURNING id`,
        [JSON.stringify(rows.map((row) => recordValues(row)))],
      );
    };
    return await work({ a, b, reader, rows, insert, instrumentTriggers });
  } finally {
    for (const client of clients) await client.query("ROLLBACK").catch(() => {});
    try {
      await a.query("RESET ROLE");
      await a.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }
}

export async function insertAudit(client: pg.Client) {
  return {
    keys: (
      await client.query(
        "SELECT DISTINCT pool,topic FROM fixture_invalidations ORDER BY pool,topic",
      )
    ).rows,
    calls: Number(
      (await client.query("SELECT count(*) AS n FROM fixture_invalidations")).rows[0].n,
    ),
    triggers: (
      await client.query(
        "SELECT level,count(*)::int AS calls FROM fixture_trigger_calls GROUP BY level ORDER BY level",
      )
    ).rows,
    writes: (
      await client.query(
        "SELECT name,count(*)::int AS calls FROM fixture_write_calls GROUP BY name ORDER BY name",
      )
    ).rows,
  };
}
