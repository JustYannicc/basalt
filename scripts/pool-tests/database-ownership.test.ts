import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import {
  homeTriggerTargets,
  normalizeHomeTriggerTableOwners,
  UnexpectedHomeTableOwner,
  type OwnershipQuerySession,
} from "../pool-database-ownership.ts";

const adminValue = process.env.POOL_TEST_ADMIN_URL;
if (!adminValue || !["localhost", "127.0.0.1"].includes(new URL(adminValue).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");

import { historyChangeStatements } from "../../src/pool/model-history/change-schema.ts";
import { poolDatabase } from "../../src/pool/database-settings.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
const owner = poolDatabase.owner;

const expectedTargets = [
  "api_key",
  "auth",
  "billing_charge",
  "billing_model_price",
  "basalt_model_requests",
  "basalt_model_traffic",
  "channel_group",
  "channel_group_detail",
  "config",
  "credential_concurrency_model_policies",
  "credential_concurrency_policies",
  "kv_store",
  "lifecycle_config",
  "model_group",
  "model_group_detail",
  "quota_snapshot",
  "quota_window",
  "user",
].sort();
const homeTargets = expectedTargets.filter((name) => !name.startsWith("basalt_model_"));

function quote(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error("invalid test identifier");
  return `"${value}"`;
}

function databaseUrl(database: string): string {
  const url = new URL(adminValue!);
  url.pathname = `/${database}`;
  url.searchParams.set("options", "-c role=postgres");
  return url.toString();
}

function clusterUrl(): string {
  return databaseUrl("postgres");
}

interface Fixture {
  admin: pg.Client;
  db: pg.Client;
  database: string;
  createRole(name: string): Promise<void>;
}

async function fixture(work: (value: Fixture) => Promise<void>): Promise<void> {
  const admin = new pg.Client({ connectionString: clusterUrl() });
  const database = `ownership_${randomUUID().replaceAll("-", "")}`;
  const roles = new Set<string>();
  let db: pg.Client | undefined;
  await admin.connect();
  try {
    const ownerRole = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [owner]);
    if (ownerRole.rowCount === 0) {
      await admin.query(
        `CREATE ROLE ${quote(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      roles.add(owner);
    }
    await admin.query(`GRANT ${quote(owner)} TO postgres`);
    await admin.query(`CREATE DATABASE ${quote(database)} OWNER ${quote(owner)}`);
    db = new pg.Client({ connectionString: databaseUrl(database) });
    await db.connect();
    await db.query(`GRANT ALL ON SCHEMA public TO ${quote(owner)}`);

    const value: Fixture = {
      admin,
      db,
      database,
      async createRole(name) {
        await admin.query(`CREATE ROLE ${quote(name)} NOLOGIN`);
        roles.add(name);
        await admin.query(`GRANT ${quote(name)} TO postgres`);
      },
    };
    await work(value);
  } finally {
    if (db) await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quote(database)}`).catch(() => {});
    for (const role of roles)
      await admin.query(`DROP ROLE IF EXISTS ${quote(role)}`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

function tracked(client: pg.Client): { session: OwnershipQuerySession; statements: string[] } {
  const statements: string[] = [];
  const session: OwnershipQuerySession = {
    async query(text, values) {
      statements.push(text);
      const result = await client.query(text, values);
      return {
        rows: result.rows,
        rowCount: result.rowCount,
      };
    },
  };
  return { session, statements };
}

async function tableOwner(client: pg.Client, table: string): Promise<string> {
  const result = await client.query(
    `SELECT r.rolname AS owner FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='public' AND c.relname=$1`,
    [table],
  );
  assert.equal(result.rowCount, 1, `expected public.${table}`);
  return String(result.rows[0].owner);
}

test("normalizes postgres-owned trigger targets, migrates triggers, preserves runtime access, then no-ops", async () => {
  assert.deepEqual(homeTriggerTargets(historyChangeStatements), expectedTargets);
  await fixture(async ({ admin, db, createRole }) => {
    for (const table of homeTargets) {
      if (table === "user") {
        await db.query(
          'CREATE TABLE public."user" (id bigserial PRIMARY KEY, username text NOT NULL)',
        );
      } else if (table === "channel_group") {
        await db.query(
          'CREATE TABLE public."channel_group" (id bigint PRIMARY KEY, channel_name text, disabled boolean, deleted_at timestamptz)',
        );
      } else if (table === "channel_group_detail") {
        await db.query(
          'CREATE TABLE public."channel_group_detail" (channel_group_id bigint, auth_id text, deleted_at timestamptz)',
        );
      } else {
        await db.query(`CREATE TABLE public.${quote(table)} (id bigint PRIMARY KEY)`);
      }
    }
    await db.query('INSERT INTO public."user" (username) VALUES ($1)', ["fixture-before-change"]);
    assert.equal(await tableOwner(db, "user"), "postgres");
    assert.equal(await tableOwner(db, "user_id_seq"), "postgres");

    const first = tracked(db);
    const normalized = await normalizeHomeTriggerTableOwners(
      first.session,
      owner,
      historyChangeStatements,
    );
    assert.deepEqual(normalized.changed, homeTargets);
    assert.deepEqual(normalized.alreadyOwned, []);
    assert.deepEqual(normalized.missing, ["basalt_model_requests", "basalt_model_traffic"]);
    assert.equal(
      first.statements.filter((sql) => /^ALTER TABLE\b/iu.test(sql.trim())).length,
      homeTargets.length,
    );
    assert.equal(await tableOwner(db, "api_key"), owner);
    assert.equal(await tableOwner(db, "user"), owner);
    assert.equal(await tableOwner(db, "user_id_seq"), owner);

    await migrateModelHistory(db);
    const trigger = await db.query(
      `SELECT count(*)::int AS count FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='user'
          AND t.tgname='basalt_pool_change_write' AND NOT t.tgisinternal`,
    );
    assert.equal(trigger.rows[0].count, 1);
    const triggerRows = () =>
      db.query(
        `SELECT c.relname AS table_name,t.oid::text AS trigger_id
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND t.tgname='basalt_pool_change_write'
      ORDER BY c.relname`,
        [expectedTargets],
      );
    const installedTriggers = (await triggerRows()).rows;
    assert.deepEqual(
      installedTriggers.map((row) => row.table_name),
      expectedTargets,
    );

    const runtime = `runtime_${randomUUID().replaceAll("-", "")}`;
    await createRole(runtime);
    await admin.query(`GRANT ${quote(owner)} TO ${quote(runtime)} WITH INHERIT TRUE, SET TRUE`);
    await admin.query(`ALTER ROLE ${quote(runtime)} LOGIN PASSWORD 'synthetic-runtime-only'`);
    const runtimeUrl = new URL(
      databaseUrl((await db.query("SELECT current_database() AS name")).rows[0].name),
    );
    runtimeUrl.username = runtime;
    runtimeUrl.password = "synthetic-runtime-only";
    runtimeUrl.searchParams.delete("options");
    const runtimeClient = new pg.Client({ connectionString: runtimeUrl.toString() });
    try {
      await runtimeClient.connect();
      const inserted = await runtimeClient.query(
        'INSERT INTO public."user" (username) VALUES ($1) RETURNING id',
        ["fixture-runtime"],
      );
      await runtimeClient.query('UPDATE public."user" SET username=$1 WHERE id=$2', [
        "fixture-runtime-updated",
        inserted.rows[0].id,
      ]);
      const persisted = await runtimeClient.query(
        'SELECT username FROM public."user" WHERE id=$1',
        [inserted.rows[0].id],
      );
      assert.equal(persisted.rows[0].username, "fixture-runtime-updated");
      assert.equal(
        (await runtimeClient.query("SELECT current_user AS role")).rows[0].role,
        runtime,
      );
      await runtimeClient.query(`SET ROLE ${quote(owner)}`);
      assert.equal(
        (await runtimeClient.query('SELECT count(*)::text AS n FROM public."user"')).rows[0].n,
        "2",
      );
      await runtimeClient.query("RESET ROLE");
      assert.equal(
        (await runtimeClient.query("SELECT current_user AS role")).rows[0].role,
        runtime,
      );
    } finally {
      await runtimeClient.end();
    }

    const repeated = tracked(db);
    const again = await normalizeHomeTriggerTableOwners(
      repeated.session,
      owner,
      historyChangeStatements,
    );
    await migrateModelHistory(repeated.session);
    assert.deepEqual((await triggerRows()).rows, installedTriggers);
    assert.equal(
      repeated.statements.some((sql) => sql.includes("CREATE OR REPLACE TRIGGER")),
      false,
    );
    assert.deepEqual(again.changed, []);
    assert.deepEqual(again.alreadyOwned, expectedTargets);
    assert.equal(
      repeated.statements.filter((sql) => /^ALTER TABLE\b/iu.test(sql.trim())).length,
      0,
    );
  });
});

test("leaves an already-owner Home trigger target untouched", async () => {
  await fixture(async ({ db }) => {
    await db.query(`SET ROLE ${quote(owner)}`);
    await db.query('CREATE TABLE public."user" (id bigserial PRIMARY KEY, username text NOT NULL)');
    await db.query("RESET ROLE");

    const before = tracked(db);
    const result = await normalizeHomeTriggerTableOwners(
      before.session,
      owner,
      historyChangeStatements,
    );
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.alreadyOwned, ["user"]);
    assert.equal(before.statements.filter((sql) => /^ALTER TABLE\b/iu.test(sql.trim())).length, 0);
    assert.equal(await tableOwner(db, "user"), owner);
    assert.equal(await tableOwner(db, "user_id_seq"), owner);
  });
});

test("rejects every unknown owner before any transfer or trigger installation", async () => {
  await fixture(async ({ db, createRole }) => {
    const other = `other_${randomUUID().replaceAll("-", "")}`;
    await createRole(other);
    await db.query('CREATE TABLE public."api_key" (id bigint PRIMARY KEY)');
    await db.query('CREATE TABLE public."user" (id bigint PRIMARY KEY, username text NOT NULL)');
    await db.query(`GRANT CREATE ON SCHEMA public TO ${quote(other)}`);
    await db.query(`ALTER TABLE public."user" OWNER TO ${quote(other)}`);

    const before = tracked(db);
    await assert.rejects(
      async () => {
        await normalizeHomeTriggerTableOwners(before.session, owner, historyChangeStatements);
        await migrateModelHistory(db);
      },
      (error: unknown) =>
        error instanceof UnexpectedHomeTableOwner &&
        error.table === "user" &&
        error.owner === other,
    );
    assert.equal(before.statements.filter((sql) => /^ALTER TABLE\b/iu.test(sql.trim())).length, 0);
    assert.equal(await tableOwner(db, "api_key"), "postgres");
    assert.equal(await tableOwner(db, "user"), other);
    const triggers = await db.query(
      `SELECT count(*)::int AS count FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('api_key','user')
          AND t.tgname LIKE 'basalt_pool_change_%' AND NOT t.tgisinternal`,
    );
    assert.equal(triggers.rows[0].count, 0);
  });
});

test("an existing history trigger target with an unknown owner refuses before transferring Home tables", async () => {
  await fixture(async ({ db, createRole }) => {
    const other = `other_${randomUUID().replaceAll("-", "")}`;
    await createRole(other);
    await db.query('CREATE TABLE public."api_key" (id bigint PRIMARY KEY)');
    await db.query("CREATE TABLE public.basalt_model_requests (id bigint PRIMARY KEY)");
    await db.query(`GRANT CREATE ON SCHEMA public TO ${quote(other)}`);
    await db.query(`ALTER TABLE public.basalt_model_requests OWNER TO ${quote(other)}`);
    const before = tracked(db);
    await assert.rejects(
      normalizeHomeTriggerTableOwners(before.session, owner, historyChangeStatements),
      (error) =>
        error instanceof UnexpectedHomeTableOwner &&
        error.table === "basalt_model_requests" &&
        error.owner === other,
    );
    assert.equal(
      before.statements.some((sql) => sql.startsWith("ALTER TABLE")),
      false,
    );
    assert.equal(await tableOwner(db, "api_key"), "postgres");
    assert.equal(await tableOwner(db, "basalt_model_requests"), other);
  });
});

test("the refusal names every unknown owner and expected owner before altering any target", async () => {
  await fixture(async ({ db, createRole }) => {
    const first = `other_${randomUUID().replaceAll("-", "")}`;
    const second = `other_${randomUUID().replaceAll("-", "")}`;
    await createRole(first);
    await createRole(second);
    await db.query("CREATE TABLE public.api_key (id bigint PRIMARY KEY)");
    await db.query("CREATE TABLE public.auth (id bigint PRIMARY KEY)");
    await db.query('CREATE TABLE public."user" (id bigint PRIMARY KEY)');
    await db.query(`GRANT CREATE ON SCHEMA public TO ${quote(first)},${quote(second)}`);
    await db.query(`ALTER TABLE public.auth OWNER TO ${quote(first)}`);
    await db.query(`ALTER TABLE public."user" OWNER TO ${quote(second)}`);
    const before = tracked(db);
    await assert.rejects(
      normalizeHomeTriggerTableOwners(before.session, owner, historyChangeStatements),
      (error) =>
        error instanceof UnexpectedHomeTableOwner &&
        error.blocked.length === 2 &&
        error.message.includes(`public."auth" owner "${first}" -> required "${owner}"`) &&
        error.message.includes(`public."user" owner "${second}" -> required "${owner}"`),
    );
    assert.equal(
      before.statements.some((sql) => sql.startsWith("ALTER TABLE")),
      false,
    );
    assert.equal(await tableOwner(db, "api_key"), "postgres");
    assert.equal(await tableOwner(db, "auth"), first);
    assert.equal(await tableOwner(db, "user"), second);
  });
});
