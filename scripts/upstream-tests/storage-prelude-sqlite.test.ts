import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect } from "effect";
import { generateMigrationFromSchema } from "fumadb-effect/migration";
import { schema } from "fumadb-effect/schema";
import { renderStatements, sqliteTransformer } from "fumadb-effect/sql";
import { currentStorageSchema } from "../../.upstream/packages/sdk/src/implementation/storage-current.ts";
import { storageSchemas } from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";

// The current local product uses PGlite. These are native SQLite SQL/locking checks,
// not proof of the local product or of an Effect SQLite driver's transaction behavior.
assert.equal(storageSchemas.at(-1)?.version, "4.0.29", "Apply the prelude source patch first");
const empty = schema({ version: "0.0.0", tables: {} });
const generated = generateMigrationFromSchema(empty, currentStorageSchema, { provider: "sqlite" });
const operations = sqliteTransformer.afterAuto!(generated, {
  prev: empty,
  next: currentStorageSchema,
  options: {},
});
const baseline = await Effect.runPromise(
  Effect.fromResult(
    renderStatements(operations, {
      provider: "sqlite",
      relationMode: "foreign-keys",
    }),
  ),
);
const queueOperations = await Effect.runPromise(
  storageSchemas.at(-1)!.up!({ auto: Effect.succeed([]) }),
);
assert.equal(queueOperations.length, 3);
const queueSql = queueOperations.map((operation) => {
  assert.equal(operation.type, "custom");
  if (operation.type !== "custom") throw new Error("Prelude must contain index SQL only");
  return operation.sql;
});
const names = [
  "executor_webhook_sources_intent",
  "executor_webhook_sources_retry",
  "executor_account_checks_account_app",
];

const prepare = (filename = ":memory:") => {
  const db = new DatabaseSync(filename);
  db.exec("pragma foreign_keys = on");
  for (const statement of baseline) db.exec(statement);
  db.exec(`insert into executor_providers (id, definition) values ('prv_fixture', '{}');
    insert into executor_accounts (id, owner, provider, method, label, encrypted_credentials, created_at,
      credential_generation, site)
    values ('acc_fixture', 'fixture-owner', 'prv_fixture', 'token', 'Retained', X'010203',
      1767225600000, 7, 'https://retained.invalid');
    insert into executor_account_targets
      (account, owner, revision, mode, enabled, device, device_name, binding, manifest_revision)
    values ('acc_fixture', 'fixture-owner', 2, 'device', 1, 'fixture-device', 'Retained device',
      'fixture-binding', 'fixture-manifest');
    insert into executor_app_connections
      (id, app, owner, dependency, subject, target, authorizer, revision, enabled, encrypted, created_at, updated_at)
    values ('connection_fixture', 'app_fixture', 'fixture-owner', 'retained', 'fixture-person',
      'app_target', 'fixture-authorizer', 2, 1, X'040506', 1767225600000, 1767225600000);
    insert into executor_app_call_receipts
      (id, app, owner, connection, state, deadline, encrypted, created_at, updated_at)
    values ('receipt_fixture', 'app_fixture', 'fixture-owner', 'connection_fixture', 'reserved',
      4070908800000, X'070809', 1767225600000, 1767225600000);`);
  return db;
};

const indexes = (db: DatabaseSync) =>
  db
    .prepare(`select name, rootpage, sql from sqlite_schema where type = 'index'
    and name in (?, ?, ?) order by name`)
    .all(...names);

const retained = (db: DatabaseSync) => ({
  tables: db
    .prepare("select name, rootpage, sql from sqlite_schema where type = 'table' order by name")
    .all(),
  accounts: db.prepare("select * from executor_accounts order by id").all(),
  targets: db.prepare("select * from executor_account_targets order by account").all(),
  connections: db.prepare("select * from executor_app_connections order by id").all(),
  receipts: db.prepare("select * from executor_app_call_receipts order by id").all(),
});

const addIndexes = (db: DatabaseSync) => {
  db.exec("begin immediate");
  try {
    for (const statement of queueSql) db.exec(statement);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
};

test("native SQLite retains the complete Basalt layout and data without rebuilding indexes on rerun", () => {
  const db = prepare();
  try {
    const before = retained(db);
    assert.equal(indexes(db).length, 0);
    addIndexes(db);
    const first = indexes(db);
    assert.deepEqual(
      first.map((row) => row.name),
      [...names].sort(),
    );
    assert.deepEqual(retained(db), before);
    addIndexes(db);
    assert.deepEqual(indexes(db), first);
    assert.deepEqual(retained(db), before);
  } finally {
    db.close();
  }
});

test("native SQLite rolls back partial index DDL and can retry", () => {
  const db = prepare();
  try {
    const before = retained(db);
    db.exec("alter table executor_account_checks rename to fixture_account_checks");
    assert.throws(() => addIndexes(db), /executor_account_checks/);
    assert.equal(indexes(db).length, 0);
    db.exec("alter table fixture_account_checks rename to executor_account_checks");
    assert.deepEqual(retained(db), before);
    addIndexes(db);
    assert.equal(indexes(db).length, 3);
  } finally {
    db.close();
  }
});

test("SQLite WAL permits an old reader but its single writer waits until additive DDL commits", () => {
  const directory = mkdtempSync(join(tmpdir(), "storage-prelude-"));
  const filename = join(directory, "fixture.sqlite");
  const migration = prepare(filename);
  const runtime = new DatabaseSync(filename);
  try {
    migration.exec("pragma journal_mode = wal");
    runtime.exec("pragma busy_timeout = 25");
    migration.exec("begin immediate");
    for (const statement of queueSql) migration.exec(statement);
    assert.equal(runtime.prepare("select label from executor_accounts").get()?.label, "Retained");
    assert.throws(
      () => runtime.exec("update executor_accounts set label = 'Old writer'"),
      /locked|busy/i,
    );
    migration.exec("commit");
    runtime.exec("update executor_accounts set label = 'Old writer'");
    assert.equal(runtime.prepare("select label from executor_accounts").get()?.label, "Old writer");
    assert.equal(indexes(runtime).length, 3);
  } finally {
    runtime.close();
    migration.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
