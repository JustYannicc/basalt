import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { makeExecutorRuntimeStorage } from "../../.upstream/packages/sdk/src/implementation/storage-runtime.ts";
import { storageSchemas } from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const SqliteClient: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-sqlite-node/dist/SqliteClient.js") =
  await import(require.resolve("@effect/sql-sqlite-node/SqliteClient"));
// Product hosts use PostgreSQL. This driver proves the additive SQLite upgrade.
const historicalDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas.slice(
    0,
    storageSchemas.findIndex((entry) => entry.version === "4.0.29"),
  ),
});

const preludeDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas.slice(
    0,
    storageSchemas.findIndex((entry) => entry.version === "4.0.29") + 1,
  ),
});
const migratePrelude = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migrator = yield* preludeDatabase.client(sqlAdapter({ provider: "sqlite" })).createMigrator;
  const version = yield* migrator.version;
  if (Option.isSome(version) && version.value === "4.0.29") return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* (yield* migrator.up()).execute;
    }),
  );
});

const inSqlite = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>, filename = ":memory:") =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename }))));

const queueIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ name: string; rootpage: number; sql: string }>`
    select name, rootpage, sql from sqlite_master where type = 'index' and name in
    ('executor_webhook_sources_intent', 'executor_webhook_sources_retry',
      'executor_account_checks_account_app') order by name`;
});
const assertIndexes = Effect.gen(function* () {
  const indexes = yield* queueIndexes;
  assert.deepEqual(
    indexes.map((row) => row.name),
    [
      "executor_account_checks_account_app",
      "executor_webhook_sources_intent",
      "executor_webhook_sources_retry",
    ],
  );
  assert.match(indexes[0]!.sql, /\(account, app\)/);
  assert.match(indexes[1]!.sql, /status = 'pending' AND lease IS NULL/);
  assert.match(indexes[2]!.sql, /status <> 'ready'/);
  return indexes;
});
const retained = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    tables:
      yield* sql`select name, rootpage, sql from sqlite_master where type = 'table' order by name`,
    accounts: yield* sql`select * from executor_accounts order by id`,
    targets: yield* sql`select * from executor_account_targets order by account`,
    connections: yield* sql`select * from executor_app_connections order by id`,
    receipts: yield* sql`select * from executor_app_call_receipts order by id`,
  };
});
const historicalLayout = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migrator = yield* historicalDatabase.client(sqlAdapter({ provider: "sqlite" }))
    .createMigrator;
  yield* (yield* migrator.migrateToLatest()).execute;
  const storage = yield* makeExecutorStorage({ provider: "sqlite" });
  assert.equal(yield* storage.version, "4.0.28");
  assert.deepEqual(yield* queueIndexes, []);
  yield* sql`insert into executor_providers (id, definition) values ('prv_fixture', '{}')`;
  yield* sql`insert into executor_accounts
    (id, owner, provider, method, label, encrypted_credentials, created_at, credential_generation, site)
    values ('acc_fixture', 'fixture-owner', 'prv_fixture', 'token', 'Retained', X'010203',
      1767225600000, 7, 'https://retained.invalid')`;
  yield* sql`insert into executor_account_targets
    (account, owner, revision, mode, enabled, device, device_name, binding, manifest_revision)
    values ('acc_fixture', 'fixture-owner', 2, 'device', 1, 'fixture-device',
      'Retained device', 'fixture-binding', 'fixture-manifest')`;
  yield* sql`insert into executor_app_connections
    (id, app, owner, dependency, subject, target, authorizer, revision, enabled, encrypted,
      created_at, updated_at)
    values ('connection_fixture', 'app_fixture', 'fixture-owner', 'retained', 'fixture-person',
      'app_target', 'fixture-authorizer', 2, 1, X'040506', 1767225600000, 1767225600000)`;
  yield* sql`insert into executor_app_call_receipts
    (id, app, owner, connection, state, deadline, encrypted, created_at, updated_at)
    values ('receipt_fixture', 'app_fixture', 'fixture-owner', 'connection_fixture', 'reserved',
      4070908800000, X'070809', 1767225600000, 1767225600000)`;
  return storage;
});

test("the historical SQLite prelude commits indexes with its marker and reopens before the current table upgrade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "storage-prelude-driver-"));
  const filename = join(directory, "fixture.sqlite");
  try {
    const before = await inSqlite(
      Effect.gen(function* () {
        const storage = yield* historicalLayout;
        const rows = yield* retained;
        assert.equal(yield* storage.version, "4.0.28");
        assert.deepEqual(yield* queueIndexes, []);
        yield* migratePrelude;
        assert.equal(yield* storage.version, "4.0.29");
        assert.deepEqual(yield* retained, rows);
        return { rows, indexes: yield* assertIndexes };
      }),
      filename,
    );
    await inSqlite(
      Effect.gen(function* () {
        const storage = yield* makeExecutorStorage({ provider: "sqlite" });
        yield* storage.checkMigration;
        yield* migratePrelude;
        assert.equal(yield* storage.version, "4.0.29");
        assert.deepEqual(yield* retained, before.rows);
        assert.deepEqual(yield* queueIndexes, before.indexes);
        yield* storage.migrateTables;
        assert.equal(yield* storage.version, "4.0.30");
        const { tables: _beforeTables, ...beforeRows } = before.rows;
        const { tables: _afterTables, ...afterRows } = yield* retained;
        assert.deepEqual(afterRows, beforeRows);
        assert.deepEqual(yield* queueIndexes, before.indexes);
        yield* storage.migrate;
        assert.equal(yield* storage.version, "4.0.30");
        assert.deepEqual(yield* queueIndexes, before.indexes);
        const runtime = yield* makeExecutorRuntimeStorage({ provider: "sqlite" });
        const orm = runtime.orm("4.0.28");
        assert.equal((yield* orm.findMany("accounts"))[0]?.label, "Retained");
        yield* orm.updateMany("accounts", { set: { label: "Written by retained ORM" } });
        assert.equal((yield* orm.findMany("accounts"))[0]?.label, "Written by retained ORM");
        assert.equal((yield* orm.findMany("accountTargets"))[0]?.binding, "fixture-binding");
        assert.equal((yield* orm.findMany("appCallReceipts"))[0]?.id, "receipt_fixture");
      }),
      filename,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the historical SQLite prelude rolls back index DDL and its marker together, then retries", async () => {
  await inSqlite(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* historicalLayout;
      const before = yield* retained;
      yield* sql`alter table executor_account_checks rename to fixture_account_checks`;
      assert.equal((yield* Effect.exit(migratePrelude))._tag, "Failure");
      assert.equal(yield* storage.version, "4.0.28");
      assert.deepEqual(yield* queueIndexes, []);
      yield* sql`alter table fixture_account_checks rename to executor_account_checks`;
      assert.deepEqual(yield* retained, before);
      yield* migratePrelude;
      assert.equal(yield* storage.version, "4.0.29");
      yield* assertIndexes;
      assert.deepEqual(yield* retained, before);
    }),
  );
});

test("the current SDK rolls back the ordered SQLite upgrade and retries without losing retained rows", async () => {
  await inSqlite(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* historicalLayout;
      const { tables: _beforeTables, ...beforeRows } = yield* retained;
      yield* sql`alter table executor_account_checks rename to fixture_account_checks`;
      assert.equal((yield* Effect.exit(storage.migrateTables))._tag, "Failure");
      assert.equal(yield* storage.version, "4.0.28");
      assert.deepEqual(yield* queueIndexes, []);
      yield* sql`alter table fixture_account_checks rename to executor_account_checks`;
      yield* storage.migrateTables;
      assert.equal(yield* storage.version, "4.0.30");
      const { tables: _afterTables, ...afterRows } = yield* retained;
      assert.deepEqual(afterRows, beforeRows);
      const indexes = yield* assertIndexes;
      yield* storage.migrate;
      assert.deepEqual(yield* queueIndexes, indexes);
      assert.equal(yield* storage.version, "4.0.30");
    }),
  );
});
