import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { generateMigrationFromSchema } from "fumadb-effect/migration";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { makeExecutorRuntimeStorage } from "../../.upstream/packages/sdk/src/implementation/storage-runtime.ts";
import {
  storageSchemas,
  trailingStorageIndexVersions,
} from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";
import {
  archive,
  assertQueueIndexes,
  assertRetained,
  historicalDatabase,
  historicalLayout,
  historicalSchemas,
  inPglite,
  preludeVersion,
  queueIndexes,
  retained,
} from "./storage-prelude-fixture.ts";
import { sqlAdapter } from "fumadb-effect/sql";

assert.equal(
  storageSchemas.at(-1)?.version,
  preludeVersion,
  "Apply the prelude source patch before running these fixtures",
);

test("fresh SDK setup has all Basalt tables and usable queue indexes; rerun keeps their identities", async () => {
  await inPglite(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      assert.equal(yield* storage.version, preludeVersion);
      const first = yield* assertQueueIndexes;
      const tables = yield* sql<{
        table_name: string;
      }>`select table_name from information_schema.tables
      where table_schema = current_schema() and table_name in
      ('executor_account_targets', 'executor_app_connections', 'executor_app_call_receipts')
      order by table_name`;
      assert.deepEqual(
        tables.map((row) => row.table_name),
        ["executor_account_targets", "executor_app_call_receipts", "executor_app_connections"],
      );
      yield* storage.migrate;
      assert.deepEqual(yield* queueIndexes, first);
    }),
  );
});

for (const history of historicalSchemas)
  test(`retained ${history.version} layout upgrades through every pending step after reopen`, async () => {
    const before = await inPglite(
      Effect.gen(function* () {
        yield* historicalLayout(history.version);
        return { rows: yield* retained, snapshot: yield* archive };
      }),
    );
    await inPglite(
      Effect.gen(function* () {
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        assert.equal(yield* storage.version, preludeVersion);
        yield* assertRetained(before.rows);
        const first = yield* assertQueueIndexes;
        yield* storage.migrate;
        assert.deepEqual(yield* queueIndexes, first);
        yield* assertRetained(before.rows);
      }),
      before.snapshot,
    );
  });

test("4.0.29 changes no tables and remains deferred until the hosted index phase", async () => {
  const previous = historicalSchemas.at(-1)!;
  const latest = storageSchemas.at(-1)!;
  assert.equal(previous.version, "4.0.28");
  assert.equal(latest.version, preludeVersion);
  assert.deepEqual(
    generateMigrationFromSchema(previous, latest, {
      provider: "postgresql",
      dropUnusedTables: true,
      dropUnusedColumns: true,
    }),
    [],
  );
  assert.deepEqual([...trailingStorageIndexVersions], [preludeVersion]);
  await inPglite(
    Effect.gen(function* () {
      yield* historicalLayout("4.0.28");
      const before = yield* retained;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrateTables;
      assert.equal(yield* storage.version, "4.0.28");
      assert.deepEqual(yield* queueIndexes, []);
      yield* assertRetained(before);
      yield* storage.migrate;
      assert.equal(yield* storage.version, preludeVersion);
      yield* assertQueueIndexes;
      yield* assertRetained(before);
    }),
  );
});

test("a high Basalt version missing upstream's lower-numbered indexes receives the additive repair", async () => {
  await inPglite(
    Effect.gen(function* () {
      yield* historicalLayout("4.0.28");
      assert.deepEqual(yield* queueIndexes, []);
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      yield* assertQueueIndexes;
    }),
  );
});

test("failure after the webhook indexes rolls back the indexes and version; retry preserves data", async () => {
  await inPglite(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* historicalLayout("4.0.28");
      const before = yield* retained;
      // The third index cannot resolve its table after the first two have executed.
      yield* sql`alter table executor_account_checks rename to fixture_account_checks`;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      const failed = yield* Effect.exit(storage.migrate);
      assert.equal(failed._tag, "Failure");
      assert.equal(yield* storage.version, "4.0.28");
      assert.deepEqual(yield* queueIndexes, []);
      yield* sql`alter table fixture_account_checks rename to executor_account_checks`;
      yield* assertRetained(before);
      yield* storage.migrate;
      assert.equal(yield* storage.version, preludeVersion);
      yield* assertQueueIndexes;
      yield* assertRetained(before);
    }),
  );
});

test("the existing 4.0.28 ORM can read and write after additive SQL commits", async () => {
  await inPglite(
    Effect.gen(function* () {
      yield* historicalLayout("4.0.28");
      const runtime = yield* makeExecutorRuntimeStorage({ provider: "postgresql" });
      const orm = runtime.orm("4.0.28");
      const before = yield* orm.findMany("accounts");
      assert.equal(before.length, 1);
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      assert.deepEqual(yield* orm.findMany("accounts"), before);
      yield* orm.updateMany("accounts", { set: { label: "Written by retained ORM" } });
      assert.equal((yield* orm.findMany("accounts"))[0]?.label, "Written by retained ORM");
      assert.equal((yield* orm.findMany("accountTargets"))[0]?.binding, "fixture-binding");
      assert.equal((yield* orm.findMany("appCallReceipts"))[0]?.id, "receipt_storageprelude");
    }),
  );
});

test("restarted prelude accepts 4.0.29; the original registry cannot migrate that snapshot", async () => {
  const before = await inPglite(
    Effect.gen(function* () {
      yield* historicalLayout("4.0.28");
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      return { rows: yield* retained, indexes: yield* queueIndexes, snapshot: yield* archive };
    }),
  );
  await inPglite(
    Effect.gen(function* () {
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.checkMigration;
      yield* storage.migrate;
      assert.equal(yield* storage.version, preludeVersion);
      yield* assertRetained(before.rows);
      assert.deepEqual(yield* queueIndexes, before.indexes);
      const old = yield* historicalDatabase.client(sqlAdapter({ provider: "postgresql" }))
        .createMigrator;
      assert.equal((yield* Effect.exit(old.migrateToLatest()))._tag, "Failure");
      assert.equal(yield* storage.version, preludeVersion);
      yield* assertRetained(before.rows);
    }),
    before.snapshot,
  );
});

test("a 4.0.29 marker with a dropped index still requires schema inventory", async () => {
  await inPglite(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* historicalLayout("4.0.28");
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      yield* sql`drop index executor_webhook_sources_retry`;
      yield* storage.migrate;
      assert.equal(yield* storage.version, preludeVersion);
      assert.equal((yield* queueIndexes).length, 2);
      // Startup checks the marker, not physical indexes. Release qualification must reject this drift.
      yield* storage.checkMigration;
    }),
  );
});
