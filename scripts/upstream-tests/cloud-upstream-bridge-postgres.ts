import assert from "node:assert/strict";
import type { BetterAuthOptions } from "better-auth";
import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import {
  HostedMigrationFailed,
  migrateHostedDatabase,
  migrationFailed,
} from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import {
  cloudMigrationSteps,
  migrateCloudProductSteps,
} from "../../.upstream/apps/hosted/cloud/src/implementation/migrations.ts";
import { journal, objects, refused } from "./cloud-upstream-bridge-fixtures.ts";

/** The parent supplies the real auth pool and a separate PgClient layer for a disposable DB. */
export const proveIndependentAuthCommit = (options: BetterAuthOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrateHostedDatabase(options, migrateCloudProductSteps());
    const before = yield* journal;
    const changed = {
      ...options,
      user: {
        ...options.user,
        additionalFields: {
          ...options.user?.additionalFields,
          bridgeCommitProbe: {
            type: "string" as const,
            required: false,
            fieldName: "bridge_commit_probe",
          },
        },
      },
    } satisfies BetterAuthOptions;
    assert.deepEqual(
      yield* sql`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'user' and column_name = 'bridge_commit_probe'`,
      [],
    );
    yield* refused(
      migrateHostedDatabase(
        changed,
        Effect.gen(function* () {
          yield* sql`insert into private_production_ops_receipts
      (plan_sha256, organization_id, migration, revision, release, backup_sha256, verification)
      values ('auth-commit-probe', 'fixture', 'fixture', 'fixture', 'fixture', 'fixture', '{}'::jsonb)`;
          return yield* new HostedMigrationFailed({
            stage: "product",
            causeTags: ["InjectedAfterAuthCommit"],
          });
        }).pipe(Effect.mapError(migrationFailed("product"))),
      ),
    );
    assert.deepEqual(
      yield* sql`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'user' and column_name = 'bridge_commit_probe'`,
      [{ column_name: "bridge_commit_probe" }],
    );
    assert.deepEqual(
      yield* sql`select plan_sha256 from private_production_ops_receipts
    where plan_sha256 = 'auth-commit-probe'`,
      [],
    );
    assert.deepEqual(yield* journal, before);
    yield* migrateHostedDatabase(changed, migrateCloudProductSteps());
    assert.deepEqual(yield* journal, before);
    const first = yield* objects;
    yield* migrateHostedDatabase(changed, migrateCloudProductSteps());
    assert.deepEqual(yield* objects, first);
    assert.deepEqual(
      yield* sql`select migration_id from private_hosted_migrations order by migration_id`,
      Array.from({ length: 18 }, (_, index) => ({ migration_id: index + 1 })),
    );
  });

/**
 * Start with Cloud 10 and the official old-pin prelude server serving this same fixture DB.
 * The callback must assert authenticated reads and writes through that running server.
 */
export const proveOldServerDuringBridge = <E, R>(
  options: BetterAuthOptions,
  verifyOldServer: Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* journal).at(-1)?.migration_id, 10);
    const entered = yield* Deferred.make<
      void,
      Effect.Error<ReturnType<typeof migrateHostedDatabase>>
    >();
    const release = yield* Deferred.make<void>();
    const pending = {
      ...cloudMigrationSteps,
      "14_v1_session_handoffs": cloudMigrationSteps["14_v1_session_handoffs"].pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
      ),
    };
    yield* verifyOldServer;
    const worker = yield* migrateHostedDatabase(options, migrateCloudProductSteps(pending)).pipe(
      Effect.onExit((exit) => Deferred.done(entered, exit)),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    // These complete while additive DDL is still uncommitted. There is no sleep or polling.
    yield* verifyOldServer.pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Fiber.join(worker);
    assert.equal((yield* journal).at(-1)?.migration_id, 19);
    yield* verifyOldServer;
    assert.deepEqual(yield* sql`select count(*)::int as count from private_v1_import_allowed`, [
      { count: 0 },
    ]);
  });
