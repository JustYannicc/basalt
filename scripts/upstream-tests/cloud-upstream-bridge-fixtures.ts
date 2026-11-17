import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Cause, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  HostedMigrationFailed,
  migrateProductSteps,
} from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import {
  cloudMigrationSteps,
  migrateCloudProductSteps,
} from "../../.upstream/apps/hosted/cloud/src/implementation/migrations.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const {
  PgliteClient,
}: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pglite/dist/PgliteClient.js") =
  await import(require.resolve("@effect/sql-pglite/PgliteClient"));

export {
  Effect,
  SqlClient,
  pgliteLayer,
  migrateProductSteps,
  cloudMigrationSteps,
  migrateCloudProductSteps,
};

export const mappedIds = [14, 15, 16, 17, 18, 19];
export const expectedIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, ...mappedIds];
export const stepsThrough = (maximum: number) =>
  Object.fromEntries(
    Object.entries(cloudMigrationSteps).filter(([key]) => Number.parseInt(key) <= maximum),
  );

export const authTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table "user" (id text primary key)`;
  yield* sql`create table organization (id text primary key, name text, logo text)`;
  yield* sql`insert into "user" (id) values ('user_bridge')`;
  yield* sql`insert into organization (id, name) values ('org_bridge', 'Bridge fixture')`;
});

export const journal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ migration_id: number; name: string; created_at: string }>`select
    migration_id, name, created_at::text from private_cloud_migrations order by migration_id`;
});

export const objects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`select c.relname, c.relkind, c.oid::int as oid from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    order by c.relname, c.relkind`;
});

export const retainedCloud = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    receipts: yield* sql`select * from private_production_ops_receipts order by plan_sha256`,
    identity: yield* sql`select * from production_ops_database_identity`,
    policies: yield* sql`select * from hosted_tool_policies order by id`,
    history: yield* sql`select * from hosted_tool_policy_history order by sequence`,
  };
});

export const seedHistory = (maximum: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* authTables;
    if (maximum === 0) return;
    yield* migrateProductSteps("private_cloud_migrations", stepsThrough(maximum));
    if (maximum >= 8)
      yield* sql`insert into private_production_ops_receipts
      (plan_sha256, organization_id, migration, revision, release, backup_sha256, verification)
      values ('bridge-plan', 'org_bridge', 'fixture', 'revision', 'release', 'backup', '{"retained":true}'::jsonb)`;
    if (maximum >= 10) {
      yield* sql`insert into hosted_tool_policies (id, organization_id, revision, definition)
      values ('policy_bridge', 'org_bridge', 2, '{"fixture":"retained"}'::jsonb)`;
      yield* sql`insert into hosted_tool_policy_history
      (organization_id, policy_id, actor, action, snapshot)
      values ('org_bridge', 'policy_bridge', 'user_bridge', 'fixture', '{"revision":2}'::jsonb)`;
    }
  });

export const dump = Effect.gen(function* () {
  const pg = (yield* PgliteClient).pglite;
  return yield* Effect.promise(() => pg.dumpDataDir());
});

export const refused = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(program);
    assert.equal(exit._tag, "Failure");
    if (exit._tag !== "Failure") throw new Error("expected a refusal");
    const error = Cause.squash(exit.cause);
    assert.ok(error instanceof HostedMigrationFailed);
    return error;
  });

export const importsStayDisabled = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "private_v1_import_allowed",
    "private_v1_import_billing",
    "private_v1_session_handoff",
    "cloud_setup_skip_assignment",
  ])
    assert.deepEqual(
      yield* sql`select count(*)::int as count from ${sql(table)}`,
      [{ count: 0 }],
      table,
    );
});
