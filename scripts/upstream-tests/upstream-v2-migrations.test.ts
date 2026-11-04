import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import {
  currentIndexes,
  storageSchemas,
} from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";
import { queueReadIndexes } from "../../.upstream/packages/sdk/src/implementation/storage-schema.ts";
import { migrateProductSteps } from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import { cloudMigrationSteps } from "../../.upstream/apps/hosted/cloud/src/implementation/migrations.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const {
  PgliteClient,
}: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pglite/dist/PgliteClient.js") =
  await import(require.resolve("@effect/sql-pglite/PgliteClient"));
const mapped = [
  "14_v1_session_handoffs",
  "15_v1_import_allowed",
  "16_setup_skip_assignments",
  "17_v1_import_billing",
  "18_v1_import_displacement",
  "19_v1_import_into",
];
const queueNames = queueReadIndexes.map((statement) => statement.match(/EXISTS (\w+)/)![1]!);
const oldCloudSteps = Object.fromEntries(
  Object.entries(cloudMigrationSteps).filter(([name]) => Number.parseInt(name) <= 10),
);

const authTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table "user" (id text primary key)`;
  yield* sql`create table organization (id text primary key, name text, logo text)`;
  yield* sql`insert into organization (id, name) values ('org_retained', 'Retained')`;
});

const queueIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ indexname: string; oid: number }>`select indexname, c.oid::int as oid
    from pg_indexes i join pg_class c on c.relname = i.indexname
    where i.schemaname = 'public' and i.indexname in ${sql.in(queueNames)} order by indexname`;
});

for (const copied of [false, true])
  test(`SDK queue repair reaches 4.0.29 once (${copied ? "copied current schema" : "fresh database"})`, async () => {
    const snapshot = copied
      ? await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const old = fumadb({
              namespace: "executor",
              schemas: storageSchemas.filter((entry) => entry.version !== "4.0.29"),
            });
            const migrator = yield* old.client(sqlAdapter({ provider: "postgresql" }))
              .createMigrator;
            yield* (yield* migrator.migrateTo("4.0.27")).execute;
            for (const statement of currentIndexes.filter(
              (entry) => !new Set<string>(queueReadIndexes).has(entry),
            ))
              yield* sql.unsafe(statement);
            yield* sql`insert into executor_providers (id, definition) values ('prv_retained', '{}'::jsonb)`;
            yield* sql`insert into executor_accounts
      (id, owner, provider, method, label, encrypted_credentials, created_at, site)
      values ('acc_retained', 'user_retained', 'prv_retained', 'token', 'Retained', decode('0102', 'hex'), now(), 'https://retained.invalid')`;
            assert.equal((yield* queueIndexes).length, 0);
          }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const pg = (yield* PgliteClient).pglite;
                return yield* Effect.promise(() => pg.dumpDataDir());
              }),
            ),
            Effect.provide(pgliteLayer()),
          ),
        )
      : undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        assert.equal(yield* storage.version, "4.0.29");
        const first = yield* queueIndexes;
        assert.deepEqual(first.map((row) => row.indexname).sort(), [...queueNames].sort());
        yield* storage.migrate;
        assert.deepEqual(yield* queueIndexes, first, "repeat migration must not rebuild indexes");
        if (copied) {
          const rows =
            yield* sql`select id, site, encode(encrypted_credentials, 'hex') as secret from executor_accounts where id = 'acc_retained'`;
          assert.deepEqual(rows, [
            { id: "acc_retained", site: "https://retained.invalid", secret: "0102" },
          ]);
        }
      }).pipe(Effect.provide(pgliteLayer(snapshot ? { loadDataDir: snapshot } : {}))),
    );
  });

const cloudJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`select migration_id, name, created_at::text from private_cloud_migrations order by migration_id`;
});
const retainedCloud = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    receipts: yield* sql`select * from private_production_ops_receipts`,
    identity: yield* sql`select * from production_ops_database_identity`,
    policies: yield* sql`select * from hosted_tool_policies`,
  };
});

for (const copied of [false, true])
  test(`Cloud 14..19 run once and retain fork 8..10 (${copied ? "copied current schema" : "fresh database"})`, async () => {
    const snapshot = copied
      ? await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* authTables;
            yield* migrateProductSteps("private_cloud_migrations", oldCloudSteps);
            yield* sql`insert into private_production_ops_receipts
      (plan_sha256, organization_id, migration, revision, release, backup_sha256, verification)
      values ('retained-plan', 'org_retained', 'retained', 'rev', 'release', 'backup', '{}'::jsonb)`;
            yield* sql`insert into hosted_tool_policies (id, organization_id, revision, definition)
      values ('policy_retained', 'org_retained', 1, '{}'::jsonb)`;
          }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const pg = (yield* PgliteClient).pglite;
                return yield* Effect.promise(() => pg.dumpDataDir());
              }),
            ),
            Effect.provide(pgliteLayer()),
          ),
        )
      : undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        if (!copied) yield* authTables;
        const before = copied ? yield* retainedCloud : undefined;
        const priorJournal = copied ? yield* cloudJournal : [];
        const counts = new Map<string, number>();
        const migrationEffects: Record<
          string,
          Effect.Effect<void, unknown, SqlClient.SqlClient>
        > = cloudMigrationSteps;
        const steps = Object.fromEntries(
          Object.entries(migrationEffects).map(([name, step]) => [
            name,
            step.pipe(
              Effect.tap(() => Effect.sync(() => counts.set(name, (counts.get(name) ?? 0) + 1))),
            ),
          ]),
        );
        yield* migrateProductSteps("private_cloud_migrations", steps);
        const first = yield* cloudJournal;
        assert.deepEqual(
          first.map((row) => Number(row.migration_id)),
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 19],
        );
        for (const name of mapped) assert.equal(counts.get(name), 1, name);
        if (copied) {
          assert.deepEqual(yield* retainedCloud, before);
          assert.deepEqual(
            first.filter((row) => Number(row.migration_id) <= 10),
            priorJournal,
          );
          for (const name of Object.keys(oldCloudSteps))
            assert.equal(counts.has(name), false, name);
        }
        const executed = [...counts];
        yield* migrateProductSteps("private_cloud_migrations", steps);
        assert.deepEqual([...counts], executed);
        assert.deepEqual(yield* cloudJournal, first);
      }).pipe(Effect.provide(pgliteLayer(snapshot ? { loadDataDir: snapshot } : {}))),
    );
  });

test("a failed mapped Cloud step rolls back its SQL and journal and can retry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* authTables;
      yield* migrateProductSteps("private_cloud_migrations", oldCloudSteps);
      const before = yield* retainedCloud;
      const failing = {
        ...cloudMigrationSteps,
        "19_v1_import_into": cloudMigrationSteps["19_v1_import_into"].pipe(
          Effect.andThen(Effect.fail(new Error("injected after step SQL"))),
        ),
      };
      const result = yield* Effect.exit(migrateProductSteps("private_cloud_migrations", failing));
      assert.equal(result._tag, "Failure");
      const journal = yield* cloudJournal;
      assert.ok(!journal.some((row) => Number(row.migration_id) === 19));
      const columns =
        yield* sql`select column_name from information_schema.columns where table_name = 'private_v1_import_allowed' and column_name in ('into_v2_org_id', 'into_mode')`;
      assert.equal(columns.length, 0);
      assert.deepEqual(yield* retainedCloud, before);
      yield* migrateProductSteps("private_cloud_migrations", cloudMigrationSteps);
      assert.equal((yield* cloudJournal).at(-1)?.migration_id, 19);
    }).pipe(Effect.provide(pgliteLayer())),
  );
});

test("a failed SDK queue repair rolls back its indexes and version and can retry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const old = fumadb({
        namespace: "executor",
        schemas: storageSchemas.filter((entry) => entry.version !== "4.0.29"),
      });
      const migrator = yield* old.client(sqlAdapter({ provider: "postgresql" })).createMigrator;
      yield* (yield* migrator.migrateTo("4.0.27")).execute;
      yield* sql`alter table executor_account_checks rename to retained_account_checks`;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      const failed = yield* Effect.exit(storage.migrate);
      assert.equal(failed._tag, "Failure");
      assert.equal(yield* storage.version, "4.0.27");
      assert.equal((yield* queueIndexes).length, 0);
      yield* sql`alter table retained_account_checks rename to executor_account_checks`;
      yield* storage.migrate;
      assert.equal(yield* storage.version, "4.0.29");
      assert.equal((yield* queueIndexes).length, queueNames.length);
    }).pipe(Effect.provide(pgliteLayer())),
  );
});
