import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { historyChangeStatements } from "../../src/pool/model-history/change-schema.ts";
import {
  historyJournalPrepareStatements,
  historyJournalActivateStatements,
} from "../../src/pool/model-history/change-journal-schema.ts";
import { poolGroupPrefix } from "../../src/pool/pool-group.ts";
import { historySchemaFixture } from "./history-fixture.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
export const localHomePostgres =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
export const historyPool = "app_serializable-history";

/** Two Home writers use distinct credentials belonging to the same actual pool app. */
export async function postgresHomeChanges(
  work: (clients: { a: pg.Client; b: pg.Client; observer: pg.Client }) => Promise<void>,
  journal: "legacy" | "prepare" | "activate" = "activate",
) {
  assert.ok(localHomePostgres, "POOL_TEST_ADMIN_URL must name isolated loopback PostgreSQL");
  const schema = `home_change_${randomUUID().replaceAll("-", "")}`;
  const observer = new pg.Client({ connectionString: adminUrl });
  const clients = ["a", "b"].map(
    () =>
      new pg.Client({
        connectionString: adminUrl,
        options: `-c search_path=${schema} -c statement_timeout=10000 -c deadlock_timeout=100`,
      }),
  );
  const [a, b] = clients;
  const connected = new Set<pg.Client>();
  await observer.connect();
  const owner = await observer.query("select oid from pg_roles where rolname='basalt_pool_owner'");
  try {
    await historySchemaFixture(observer, schema);
    await observer.query(`set search_path=${schema}`);
    await observer.query("set role basalt_pool_owner");
    await observer.query(`create table channel_group(id bigint primary key,channel_name text,
      disabled boolean default false,deleted_at timestamptz);
      create table channel_group_detail(id bigint primary key,channel_group_id bigint,
        auth_id text,deleted_at timestamptz);
      create index on channel_group_detail(auth_id,deleted_at,channel_group_id);
      create table auth(uuid text primary key,label text);`);
    for (const statement of historyChangeStatements) await observer.query(statement);
    if (journal !== "legacy")
      for (const statement of historyJournalPrepareStatements) await observer.query(statement);
    if (journal === "activate")
      for (const statement of historyJournalActivateStatements) await observer.query(statement);
    await observer.query("insert into channel_group(id,channel_name) values(1,$1)", [
      poolGroupPrefix + historyPool,
    ]);
    await observer.query(`insert into channel_group_detail values
      (1,1,'target-credential',null),(2,1,'unrelated-credential',null)`);
    await observer.query(
      "insert into auth values('target-credential','Initial'),('unrelated-credential','Initial')",
    );
    await Promise.all(
      clients.map(async (client) => {
        await client.connect();
        connected.add(client);
      }),
    );
    await Promise.all(clients.map((client) => client.query("set role basalt_pool_owner")));
    await work({ a: a!, b: b!, observer });
  } finally {
    await Promise.all(
      clients.map(async (client) => {
        if (connected.has(client)) await client.query("rollback").catch(() => {});
        await client.end();
      }),
    );
    await observer.query("reset role");
    await observer.query(`drop schema if exists ${schema} cascade`);
    if (owner.rows.length === 0) await observer.query("drop role basalt_pool_owner");
    await observer.end();
  }
}
