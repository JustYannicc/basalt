import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Deferred, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import pg from "pg";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { makeExecutorRuntimeStorage } from "../../.upstream/packages/sdk/src/implementation/storage-runtime.ts";
import {
  assertQueueIndexes,
  assertRetained,
  historicalLayout,
  queueIndexes,
  retained,
  preludeSchemas,
} from "./storage-prelude-fixture.ts";

const preludeDatabase = fumadb({ namespace: "executor", schemas: preludeSchemas });

const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const PgClient: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pg/dist/PgClient.js") =
  await import(require.resolve("@effect/sql-pg/PgClient"));
const inPostgres = <A, E>(url: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })));

test(
  "the retained 4.0.28 runtime serves during PostgreSQL index DDL and queue writes recover after commit",
  { skip: !local },
  async () => {
    const database = `storage_prelude_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${database}`);
    const target = new URL(adminUrl!);
    target.pathname = `/${database}`;
    const url = target.toString();
    const queueWriter = new pg.Client({
      connectionString: url,
      application_name: "retained-runtime-queue-writer",
    });
    try {
      const before = await Effect.runPromise(
        inPostgres(
          url,
          Effect.gen(function* () {
            yield* historicalLayout("4.0.28");
            const storage = yield* makeExecutorStorage({ provider: "postgresql" });
            assert.equal(yield* storage.version, "4.0.28");
            assert.deepEqual(yield* queueIndexes, []);
            return yield* retained;
          }),
        ),
      );
      await queueWriter.connect();
      await queueWriter.query("set lock_timeout = '100ms'");
      const runtimeReady = Deferred.makeUnsafe<void>();
      const indexesBuilt = Deferred.makeUnsafe<void>();
      const releaseMigration = Deferred.makeUnsafe<void>();
      const committed = Deferred.makeUnsafe<void>();
      const migration = inPostgres(
        url,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* Deferred.await(runtimeReady);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local lock_timeout = '5s'`;
              yield* sql`set local statement_timeout = '60s'`;
              const storage = yield* makeExecutorStorage({ provider: "postgresql" });
              const migrator = yield* preludeDatabase.client(sqlAdapter({ provider: "postgresql" }))
                .createMigrator;
              yield* (yield* migrator.up()).execute;
              assert.equal(yield* storage.version, "4.0.29");
              yield* assertQueueIndexes;
              yield* Deferred.succeed(indexesBuilt, undefined);
              yield* Deferred.await(releaseMigration);
            }),
          );
          yield* Deferred.succeed(committed, undefined);
        }),
      );
      const runtime = inPostgres(
        url,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Capture the existing runtime before the migration starts. Its ORM still uses layout 4.0.28.
          const storage = yield* makeExecutorRuntimeStorage({ provider: "postgresql" });
          const orm = storage.orm("4.0.28");
          const accounts = yield* orm.findMany("accounts");
          assert.equal(accounts.length, 1);
          yield* Deferred.succeed(runtimeReady, undefined);
          yield* Deferred.await(indexesBuilt);
          const [version] = yield* sql<{
            value: string;
          }>`select value from private_executor_settings where key = 'version'`;
          assert.equal(
            version?.value,
            "4.0.28",
            "the new marker is invisible until the index transaction commits",
          );
          assert.deepEqual(yield* queueIndexes, []);
          assert.deepEqual(yield* orm.findMany("accounts"), accounts);
          assert.equal((yield* orm.findMany("webhookSources")).length, 64);
          assert.equal((yield* orm.findMany("accountChecks")).length, 1);
          yield* orm.updateMany("accounts", { set: { label: "Written during migration" } });
          assert.equal((yield* orm.findMany("accounts"))[0]?.label, "Written during migration");
          yield* orm.updateMany("accounts", { set: { label: "Retained" } });
          for (const statement of [
            "update executor_webhook_sources set lease_until = lease_until where id = 'source_1'",
            "update executor_account_checks set status = status where id = 'check_storageprelude'",
          ]) {
            yield* Effect.promise(() =>
              assert.rejects(queueWriter.query(statement), { code: "55P03" }),
            );
          }
          yield* Deferred.succeed(releaseMigration, undefined);
          yield* Deferred.await(committed);
          for (const statement of [
            "update executor_webhook_sources set lease_until = lease_until where id = 'source_1'",
            "update executor_account_checks set status = status where id = 'check_storageprelude'",
          ]) {
            const written = yield* Effect.promise(() => queueWriter.query(statement));
            assert.equal(written.rowCount, 1);
          }
          const [after] = yield* sql<{
            value: string;
          }>`select value from private_executor_settings where key = 'version'`;
          assert.equal(after?.value, "4.0.29");
          const indexes = yield* assertQueueIndexes;
          yield* assertRetained(before);
          assert.deepEqual(yield* orm.findMany("accounts"), accounts);
          const restarted = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* restarted.checkMigration;
          const migrator = yield* preludeDatabase.client(sqlAdapter({ provider: "postgresql" }))
            .createMigrator;
          yield* (yield* migrator.migrateToLatest()).execute;
          assert.deepEqual(yield* queueIndexes, indexes);
          yield* assertRetained(before);
        }),
      );
      await Effect.runPromise(Effect.all([migration, runtime], { concurrency: "unbounded" }));
    } finally {
      await queueWriter.end();
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  },
);
