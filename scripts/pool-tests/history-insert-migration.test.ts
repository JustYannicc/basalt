import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  beforeRowInvalidation,
  historyInsertFixture,
  insertAudit,
  insertPools,
  rowVersion,
} from "./history-insert-fixture.ts";
import {
  migrateModelHistory,
  historySchemaMigrations,
} from "../../src/pool/model-history/schema.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";

test("every direct history partition keeps the same invalidation as before v11", async () => {
  await historyInsertFixture(async ({ a, reader, rows, insert, instrumentTriggers }) => {
    const incoming = await rows(Array.from({ length: 512 }, () => insertPools[0]!));
    const selected = [];
    for (let part = 0; part < 16; part++) {
      const match = (
        await a.query(
          `SELECT id FROM unnest($1::char(64)[]) AS incoming(id)
        WHERE satisfies_hash_partition('basalt_model_requests'::regclass,16,$2,id) LIMIT 1`,
          [incoming.map((row) => row.id), part],
        )
      ).rows[0];
      assert.ok(match);
      selected.push(incoming.find((row) => row.id === match.id)!);
    }
    const before = [];
    for (let part = 0; part < 16; part++) {
      await a.query("BEGIN");
      await insert(a, [selected[part]!], `basalt_model_requests_${part}`);
      before.push((await insertAudit(a)).keys);
      await a.query("ROLLBACK");
    }
    const catalog = async () => ({
      triggers: (
        await a.query(
          "SELECT pg_get_triggerdef(t.oid) AS sql FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace=current_schema()::regnamespace ORDER BY t.oid",
        )
      ).rows,
      watcher: (
        await a.query(
          "SELECT pg_get_functiondef('basalt_pool_record_change()'::regprocedure) AS sql",
        )
      ).rows,
    });
    const original = await catalog();
    await migrateModelHistory(a);
    assert.deepEqual(await catalog(), original);
    await instrumentTriggers();
    for (let part = 0; part < 16; part++) {
      await a.query("TRUNCATE fixture_invalidations,fixture_trigger_calls,fixture_write_calls");
      await insert(a, [selected[part]!], `basalt_model_requests_${part}`);
      const after = await insertAudit(a);
      assert.deepEqual(after.keys, before[part]);
      assert.equal(after.calls, 1);
      assert.deepEqual(after.triggers, [{ level: "ROW", calls: 1 }]);
      const hints = await readPoolHistoryChanges(reader, insertPools[0]!);
      assert.equal(hints.find((hint) => hint.topic === "pool-usage")!.revision, String(part + 1));
    }
  });
});

test("an old writer overlapping the v11 switch and a new writer both invalidate after commit", async () => {
  await historyInsertFixture(async ({ a, b, reader, rows, insert }) => {
    const before = await rows(Array.from({ length: 100 }, () => insertPools[0]!));
    const after = await rows(Array.from({ length: 100 }, () => insertPools[0]!));
    const revision = async () =>
      (await readPoolHistoryChanges(reader, insertPools[0]!)).find(
        (hint) => hint.topic === "pool-usage",
      )!.revision;
    assert.equal(await revision(), "0");
    await a.query("BEGIN");
    await a.query("UPDATE channel_group SET disabled=disabled WHERE id=1");
    await insert(a, before);
    let switching!: () => void;
    const requested = new Promise<void>((resolve) => {
      switching = resolve;
    });
    const migration = migrateModelHistory({
      query(text, values) {
        const pending = b.query(text, values);
        if (text.startsWith("DO $$ BEGIN IF to_regclass('channel_group')")) switching();
        return pending;
      },
    });
    await Promise.race([
      requested,
      migration.then(() => {
        throw new Error("v11 did not request its group index");
      }),
    ]);
    assert.equal(await revision(), "0");
    await a.query("COMMIT");
    await migration;
    assert.equal(await revision(), "1");
    await insert(b, after);
    assert.equal(await revision(), "2");
    assert.equal((await reader.query("SELECT id FROM basalt_model_requests")).rows.length, 200);
    assert.equal(
      (
        await reader.query("SELECT name FROM basalt_model_history_migrations WHERE name=$1", [
          rowVersion,
        ])
      ).rows.length,
      1,
    );
    const markers = (
      await reader.query("SELECT * FROM basalt_model_history_migrations ORDER BY name")
    ).rows;
    const triggers = (
      await reader.query(
        "SELECT t.oid,t.tgtype,t.tgrelid,t.tgfoid FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace=current_schema()::regnamespace ORDER BY t.oid",
      )
    ).rows;
    await migrateModelHistory(b);
    assert.deepEqual(
      (await reader.query("SELECT * FROM basalt_model_history_migrations ORDER BY name")).rows,
      markers,
    );
    assert.deepEqual(
      (
        await reader.query(
          "SELECT t.oid,t.tgtype,t.tgrelid,t.tgfoid FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace=current_schema()::regnamespace ORDER BY t.oid",
        )
      ).rows,
      triggers,
    );
  });
});

test("a blocked v11 migration rolls back its DDL and marker and leaves the old insert path working", async () => {
  await historyInsertFixture(async ({ a, b, reader, rows, insert }) => {
    const incoming = await rows([insertPools[0]!]);
    await a.query("BEGIN");
    await a.query("UPDATE channel_group SET disabled=disabled WHERE id=1");
    await insert(a, incoming);
    await assert.rejects(
      migrateModelHistory(b),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "55P03",
    );
    assert.equal(
      (
        await reader.query("SELECT name FROM basalt_model_history_migrations WHERE name=$1", [
          rowVersion,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (await reader.query("SELECT to_regprocedure('basalt_pool_history_hash(text)') AS function"))
        .rows[0].function,
      null,
    );
    await a.query("COMMIT");
    const retained = await rows([insertPools[1]!]);
    await insert(a, retained);
    const old = await insertAudit(a);
    assert.equal(old.calls, 2);
    assert.deepEqual(old.triggers, [{ level: "ROW", calls: 2 }]);
    await migrateModelHistory(b);
    await insert(a, await rows([insertPools[0]!]));
    assert.equal((await reader.query("SELECT id FROM basalt_model_requests")).rows.length, 3);
    const hints = await readPoolHistoryChanges(reader, insertPools[0]!);
    assert.equal(hints.find((hint) => hint.topic === "pool-usage")!.revision, "2");
  });
});

test("v11 refuses non-UTF8 hashing atomically and preserves retained legacy history", async () => {
  const source = process.env.POOL_TEST_ADMIN_URL;
  assert.ok(source && ["127.0.0.1", "localhost"].includes(new URL(source).hostname));
  const name = `history_encoding_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: source });
  const url = new URL(source);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.href });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    await db.connect();
    await db.query(
      "DO $$ BEGIN CREATE ROLE basalt_pool_owner NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
    );
    await db.query("ALTER SCHEMA public OWNER TO basalt_pool_owner; SET ROLE basalt_pool_owner");
    await db.query(
      "CREATE TABLE basalt_model_history_migrations(name text PRIMARY KEY,completed_at timestamptz DEFAULT CURRENT_TIMESTAMP)",
    );
    for (const migration of historySchemaMigrations.filter(beforeRowInvalidation)) {
      for (const sql of migration.statements) await db.query(sql);
      await db.query("INSERT INTO basalt_model_history_migrations(name) VALUES($1)", [
        migration.name,
      ]);
    }
    await db.query(
      `INSERT INTO basalt_model_requests
      (id,source,source_record,timestamp,timestamp_exact,token_quality,failed,cost_basis,attribution)
      VALUES($1,$2,$3,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','legacy',false,'unpriced','unknown')`,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    );
    const before = (await db.query("SELECT * FROM basalt_model_requests")).rows;
    await assert.rejects(
      migrateModelHistory(db),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "0A000",
    );
    assert.deepEqual((await db.query("SELECT * FROM basalt_model_requests")).rows, before);
    assert.equal(
      (
        await db.query("SELECT name FROM basalt_model_history_migrations WHERE name=$1", [
          rowVersion,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT to_regprocedure('basalt_pool_history_hash(text)') AS hash")).rows[0]!
        .hash,
      null,
    );
  } finally {
    await db.end();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await admin.end();
    }
  }
});
