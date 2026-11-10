import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { Client } from "pg";
import { cloudAuthSetup } from "../../.upstream/apps/hosted/cloud/src/implementation/auth-provisioning.ts";
import {
  migrateHostedDatabase,
  migrateProductSteps,
} from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import { proveIndependentAuthCommit } from "./cloud-upstream-bridge-postgres.ts";
import { retainedCloud, stepsThrough } from "./cloud-upstream-bridge-fixtures.ts";

const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local = (() => {
  try {
    return (
      adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname)
    );
  } catch {
    return false;
  }
})();

async function fixtureDatabase() {
  assert.ok(adminUrl && local);
  const database = `bridge_auth_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database "${database}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const target = new URL(adminUrl);
  target.pathname = `/${database}`;
  return {
    database,
    url: target.toString(),
    close: async () => {
      try {
        await admin.query(`drop database "${database}" with (force)`);
      } finally {
        await admin.end();
      }
    },
  };
}

test(
  "Better Auth commits its schema on its own pool when the Cloud product transaction rolls back",
  { skip: !local },
  async () => {
    const fixture = await fixtureDatabase();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { options } = yield* cloudAuthSetup;
            const authPool = options.database;
            const authSession = yield* Effect.tryPromise(() =>
              authPool.query<{ pid: number; database: string }>(
                "select pg_backend_pid()::int as pid, current_database() as database",
              ),
            );
            const sql = yield* SqlClient.SqlClient;
            const runtime = yield* sql<{ pid: number; database: string }>`
              select pg_backend_pid()::int as pid, current_database() as database`;
            assert.equal(authSession.rows[0]?.database, fixture.database);
            assert.equal(runtime[0]?.database, fixture.database);
            assert.notEqual(
              runtime[0]?.pid,
              authSession.rows[0]?.pid,
              "Better Auth and Effect use distinct PG sessions",
            );

            yield* migrateHostedDatabase(options);
            yield* sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
              values ('user_bridge', 'Bridge fixture', 'bridge@example.invalid', true, now(), now())`;
            yield* sql`insert into organization (id, name, slug, "createdAt", metadata)
              values ('org_bridge', 'Bridge fixture', 'bridge-fixture', now(), '{}')`;
            yield* migrateProductSteps("private_cloud_migrations", stepsThrough(10));
            yield* sql`insert into private_production_ops_receipts
              (plan_sha256, organization_id, migration, revision, release, backup_sha256, verification)
              values ('bridge-plan', 'org_bridge', 'fixture', 'revision', 'release', 'backup', '{"retained":true}'::jsonb)`;
            yield* sql`insert into hosted_tool_policies (id, organization_id, revision, definition)
              values ('policy_bridge', 'org_bridge', 2, '{"fixture":"retained"}'::jsonb)`;
            yield* sql`insert into hosted_tool_policy_history
              (organization_id, policy_id, actor, action, snapshot)
              values ('org_bridge', 'policy_bridge', 'user_bridge', 'fixture', '{"revision":2}'::jsonb)`;
            const retained = yield* retainedCloud;

            yield* proveIndependentAuthCommit(options);

            const authColumn = yield* Effect.tryPromise(() =>
              authPool.query<{ column_name: string }>(
                `select column_name from information_schema.columns
                 where table_schema = 'public' and table_name = 'user'
                   and column_name = 'bridge_commit_probe'`,
              ),
            );
            assert.deepEqual(authColumn.rows, [{ column_name: "bridge_commit_probe" }]);
            assert.deepEqual(
              yield* sql`select column_name from information_schema.columns
                where table_schema = 'public' and table_name = 'user'
                  and column_name = 'bridge_commit_probe'`,
              [{ column_name: "bridge_commit_probe" }],
            );
            assert.deepEqual(
              yield* sql`select count(*)::int as count from private_production_ops_receipts
                where plan_sha256 = 'auth-commit-probe'`,
              [{ count: 0 }],
              "the later product transaction rolls back its write",
            );
            assert.deepEqual(yield* retainedCloud, retained);
          }),
        ).pipe(
          Effect.provide(PgClient.layer({ url: Redacted.make(fixture.url), maxConnections: 1 })),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              DATABASE_URL: fixture.url,
              BETTER_AUTH_URL: "http://localhost:3000",
              BETTER_AUTH_SECRET: "fixture-only-auth-secret-0123456789abcdef",
              GOOGLE_CLIENT_ID: "fixture",
              GOOGLE_CLIENT_SECRET: "fixture",
              GITHUB_CLIENT_ID: "fixture",
              GITHUB_CLIENT_SECRET: "fixture",
            }),
          ),
        ),
      );
    } finally {
      await fixture.close();
    }
  },
);
