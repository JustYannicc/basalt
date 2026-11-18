import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { parseBulkUsageImport } from "../../src/pool/model-history/import.ts";
import type { ModelRequest } from "../../src/pool/model-history/record.ts";
import { historyRecordLayout, recordValues } from "../../src/pool/model-history/store.ts";
import { historyChangeOnceVersion } from "../../src/pool/model-history/history-row-schema.ts";
import {
  activateModelHistoryJournal,
  historySchemaMigrations,
  migrateModelHistory,
} from "../../src/pool/model-history/schema.ts";
import { historySchemaFixture } from "./history-fixture.ts";

export const pools = ["app_fixture_once_a", "app_fixture_once_b"] as const;
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export type Version = "v11" | "v12";

/** Synthetic Home tables for every watcher mode one model request or its upkeep can reach. */
const homeTables = `CREATE TABLE channel_group(id bigint PRIMARY KEY,channel_name text,
    disabled boolean DEFAULT false,deleted_at timestamptz);
  CREATE TABLE channel_group_detail(id bigint PRIMARY KEY,channel_group_id bigint,auth_id text,
    deleted_at timestamptz);
  CREATE INDEX ON channel_group_detail(auth_id,deleted_at,channel_group_id);
  CREATE TABLE auth(uuid text PRIMARY KEY,id text,index text,provider text,status text,
    auth_json jsonb,updated_at timestamptz);
  CREATE TABLE quota_snapshot(credential_id text PRIMARY KEY,quota_status text,lease_until timestamptz);
  CREATE TABLE "user"(id bigint PRIMARY KEY,username text,credits numeric,updated_at timestamptz);
  CREATE TABLE api_key(id bigint PRIMARY KEY,user_id bigint,display_name text,last_used_at timestamptz);
  CREATE TABLE billing_charge(id bigserial PRIMARY KEY,usage_id bigint,amount numeric,user_id bigint,
    api_key_id bigint,matched_price_rule text);
  CREATE TABLE kv_store(key text PRIMARY KEY,value bytea);
  CREATE TABLE model_group(id bigint PRIMARY KEY,group_name text,disabled boolean,deleted_at timestamptz);
  CREATE TABLE basalt_model_history_migrations(name text PRIMARY KEY,
    completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`;

/** Every PL/pgSQL variable the v12 watcher's queries reference, as a future Home column could name it. */
const triggerVariables = [
  "mode",
  "before_row",
  "after_row",
  "change_topic",
  "memo",
  "pending",
  "targets",
];

/** One fresh schema at production's v11 state, or after the real v12 apply on top of it. */
export async function homeChangeFixture<T>(
  version: Version,
  journal: boolean,
  work: (clients: { a: pg.Client; b: pg.Client; owner: pg.Client }) => Promise<T>,
  { home = true, clash = false } = {},
) {
  const url = process.env.POOL_TEST_ADMIN_URL;
  assert.ok(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname));
  const schema = `history_once_${randomUUID().replaceAll("-", "")}`;
  const [a, b, owner] = [0, 1, 2].map(() => new pg.Client({ connectionString: url }));
  const clients = [a!, b!, owner!];
  await Promise.all(clients.map((client) => client.connect()));
  try {
    await historySchemaFixture(owner!, schema);
    for (const client of clients) await client.query(`SET search_path TO ${schema}`);
    await owner!.query("SET ROLE basalt_pool_owner");
    await owner!.query(
      home
        ? homeTables
        : homeTables.slice(homeTables.indexOf("CREATE TABLE basalt_model_history_migrations")),
    );
    if (clash)
      for (const table of ["channel_group", "channel_group_detail", '"user"'])
        await owner!.query(
          `ALTER TABLE ${table} ${triggerVariables.map((name) => `ADD COLUMN ${name} text`).join(",")}`,
        );
    for (const migration of historySchemaMigrations) {
      if (migration.name === historyChangeOnceVersion) continue;
      for (const statement of migration.statements) await owner!.query(statement);
      await owner!.query("INSERT INTO basalt_model_history_migrations(name) VALUES($1)", [
        migration.name,
      ]);
    }
    if (journal) await activateModelHistoryJournal(owner!);
    if (version === "v12") await migrateModelHistory(owner!);
    await owner!.query(
      "INSERT INTO basalt_pool_change_heads VALUES($1,'pool-readings',0),($1,'pool-usage',0),($2,'pool-readings',0),($2,'pool-usage',0) ON CONFLICT DO NOTHING",
      [...pools],
    );
    if (home) await seedHome(owner!);
    await owner!.query("TRUNCATE basalt_pool_change_pending,basalt_pool_change_dirty");
    if (journal) await owner!.query("TRUNCATE basalt_pool_change_batches");
    await owner!.query("UPDATE basalt_pool_change_heads SET revision=0");
    for (const client of [a!, b!]) await client.query("SET ROLE basalt_pool_owner");
    return await work({ a: a!, b: b!, owner: owner! });
  } finally {
    for (const client of clients) await client.query("ROLLBACK").catch(() => {});
    try {
      await owner!.query("RESET ROLE");
      await owner!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }
}

async function seedHome(owner: pg.Client) {
  await owner.query(
    "INSERT INTO channel_group VALUES(1,$1,false,NULL),(2,$2,false,NULL),(3,'unrelated',false,NULL)",
    [`signalbox-pool-${pools[0]}`, `signalbox-pool-${pools[1]}`],
  );
  await owner.query(`INSERT INTO channel_group_detail VALUES(1,1,'acct-a',NULL),(2,2,'acct-b',NULL);
      INSERT INTO auth VALUES('acct-a','a','0','codex','active','{"status_message":"ok","model_states":{"m":{"status":"ok","updated_at":"t0"}}}',now()),
        ('acct-b','b','1','codex','active','{}',now());
      INSERT INTO quota_snapshot VALUES('acct-a','ok',NULL);
      INSERT INTO api_key VALUES(1,1,'key',NULL);
      INSERT INTO kv_store VALUES('billing.settings',convert_to('{"allow_unpriced_models":true}','UTF8'))`);
  await owner.query(`INSERT INTO "user" VALUES(1,$1,100,now()),(2,$2,100,now())`, [
    await backendUserName("person", pools[0]),
    await backendUserName("person", pools[1]),
  ]);
}

/** What this open transaction has produced: its journal keys, or the legacy heads it bumped. */
export async function produced(client: Queryable) {
  return {
    dirty: (
      await client.query(`SELECT pool,topic FROM basalt_pool_change_dirty
        WHERE transaction_id=txid_current() ORDER BY pool,topic`)
    ).rows,
    heads: (
      await client.query(
        "SELECT pool,topic,revision::int FROM basalt_pool_change_heads ORDER BY pool,topic",
      )
    ).rows,
  };
}

/** Counts executor statements the triggers run, the unit PlanetScale's insights count. */
export async function countTriggerStatements(client: pg.Client) {
  await client.query("RESET ROLE");
  await client.query(`LOAD 'auto_explain'`);
  await client.query(`SET auto_explain.log_min_duration=0;SET auto_explain.log_nested_statements=on;
    SET auto_explain.log_level=notice;SET auto_explain.log_format=text`);
  await client.query("SET ROLE basalt_pool_owner");
  const sent = new Set<string>();
  const messages: string[] = [];
  client.on("notice", (notice) => {
    if (notice.message?.includes("Query Text: ")) messages.push(notice.message);
  });
  const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
  const measured = {
    query: (text: string, values?: unknown[]) => {
      sent.add(text);
      return query(text, values) as Promise<pg.QueryResult>;
    },
  };
  return {
    measured,
    take() {
      const nested = messages.filter(
        (message) => ![...sent].some((text) => message.includes(`Query Text: ${text}`)),
      );
      messages.length = 0;
      sent.clear();
      return nested.length;
    },
  };
}

let sequence = 0;
/** History rows attributed to each named pool, or unattributed for null. */
export async function historyRows(rowPools: readonly (string | null)[]): Promise<ModelRequest[]> {
  const data = (
    await Promise.all(
      rowPools.map(async () =>
        JSON.stringify({
          event_hash: await digest(`once-${process.pid}-${++sequence}`),
          timestamp: "2026-01-01T00:00:00Z",
          failed: false,
        }),
      ),
    )
  ).join("\n");
  const parsed = await parseBulkUsageImport(
    { source: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", format: "cpamp-v1-jsonl", data },
    { pool: pools[0], person: "fixture-owner" },
  );
  return Promise.all(
    parsed.records.map(async (row, index) => ({
      ...row,
      pool: rowPools[index] === null ? null : (await digest(rowPools[index]!)).slice(0, 16),
    })),
  );
}

/** The capture writer's statement shape: one multi-row INSERT that skips retained IDs. */
export function insertHistory(client: Queryable, rows: readonly ModelRequest[]) {
  const { selected, types } = historyRecordLayout(true);
  return client.query(
    `INSERT INTO basalt_model_requests (${selected}) SELECT ${selected}
    FROM jsonb_to_recordset($1::jsonb) AS incoming(${types}) ON CONFLICT(id) DO NOTHING`,
    [JSON.stringify(rows.map((row) => recordValues(row)))],
  );
}
