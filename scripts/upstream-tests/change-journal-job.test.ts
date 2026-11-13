import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Effect, Redacted } from "effect";
import pg from "pg";
import { SqlClient } from "effect/sql";
import { migrateProductSteps } from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { migrateDeferredChanges } from "../../.upstream/apps/hosted/server/src/implementation/deferred-change-schema.ts";
import { prepareChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-journal-schema.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const PgClient: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pg/dist/PgClient.js") =
  await import(require.resolve("@effect/sql-pg/PgClient"));
const adminUrl = process.env.POOL_TEST_ADMIN_URL;
const localPostgres = (() => {
  try {
    return (
      adminUrl !== undefined &&
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(adminUrl).hostname)
    );
  } catch {
    return false;
  }
})();
const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
const activate = ["--activate-change-journal", "--readers-ready=checkpoint-count-v1"];

function cli(url: string, args: string[]): Promise<{ status: number; output: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "bun",
      ["src/migrate.ts", ...args],
      {
        cwd: cloud,
        env: { PATH: process.env.PATH, DATABASE_URL: url, NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 25_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(
            new Error("Hosted CLI did not finish within its fixture bound or could not start"),
          );
          return;
        }
        resolve({ status: error === null ? 0 : Number(error.code), output: stdout + stderr });
      },
    );
  });
}

test(
  "the actual Hosted CLI activates only the prepared journal without auth or cloud provisioning",
  {
    skip: !localPostgres,
    timeout: 180_000,
  },
  async () => {
    const database = "change_journal_job_" + randomUUID().replaceAll("-", "");
    const target = new URL(adminUrl!);
    target.pathname = "/" + database;
    target.searchParams.delete("options");
    const url = target.toString();
    const admin = new pg.Client({
      connectionString: adminUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    const fixture = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    let created = false;
    const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.runPromise(
        work.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))),
      );
    const markers = async () =>
      (
        await fixture.query(
          "select migration_id from private_hosted_migrations order by migration_id",
        )
      ).rows;
    const state = async () =>
      (
        await fixture.query(
          "select hosted_change_revision('organization:fixture','deployment','app_fixture')::text as logical," +
            " (select revision::text from hosted_change_heads where scope='organization:fixture' and topic='deployment' and resource='app_fixture') as physical," +
            " (select count(*)::int from hosted_change_dirty) as dirty," +
            " (select count(*)::int from hosted_change_batches) as batches",
        )
      ).rows[0];
    try {
      await admin.connect();
      const version = Number(
        (await admin.query("show server_version_num")).rows[0].server_version_num,
      );
      assert.ok(version >= 170000 && version < 180000, "This proof requires PostgreSQL 17");
      await admin.query("create database " + database);
      created = true;
      await fixture.connect();

      for (const args of [[activate[0]!], [activate[0]!, "--readers-ready=legacy-count-v1"]]) {
        const usage = await cli(url, args);
        assert.equal(
          usage.status,
          2,
          "Missing or wrong reader acknowledgement must fail before the job starts",
        );
        assert.ok(
          usage.output.includes("Use no arguments to prepare schemas"),
          "Invalid flags must print static usage",
        );
        assert.ok(
          !usage.output.includes("Migration step"),
          "Invalid flags must not enter a migration job",
        );
      }
      await run(
        migrateProductSteps("private_hosted_migrations", { "20_account_changes": Effect.void }),
      );
      const unprepared = await cli(url, activate);
      assert.equal(unprepared.status, 1, "Activation before preparation must fail");
      assert.ok(
        unprepared.output.includes(
          "private_hosted_migrations is missing 21_change_journal_prepare",
        ),
        "Unprepared activation must name the missing exact step",
      );
      assert.ok(!unprepared.output.includes(url), "The refusal must not print the database URL");
      assert.ok(
        !unprepared.output.toLowerCase().includes("password"),
        "The refusal must not print driver credentials",
      );
      assert.deepEqual(await markers(), [{ migration_id: 20 }]);

      await fixture.query(
        "create table executor_apps (id text primary key,owner text not null,active_deployment text)",
      );
      await run(
        Effect.gen(function* () {
          yield* migrateChangeRevisions;
          yield* migrateDeferredChanges;
          yield* migrateProductSteps("private_hosted_migrations", {
            "21_change_journal_prepare": prepareChangeJournal,
          });
        }),
      );
      await fixture.query(
        "insert into executor_apps values ('app_fixture','organization:fixture','before-cutover')",
      );
      assert.deepEqual(await state(), { logical: "1", physical: "1", dirty: 0, batches: 0 });
      await fixture.query(
        "insert into private_hosted_migrations(migration_id,name) values(23,'later_preparation')",
      );

      const normal = await cli(url, []);
      assert.equal(
        normal.status,
        1,
        "The normal migration path still needs its auth configuration",
      );
      assert.ok(
        normal.output.includes('Cloud migration failed at "open the database sessions"'),
        "No arguments must select the normal migration job",
      );
      assert.ok(
        !normal.output.includes("activate the prepared change journal"),
        "Normal migration must not activate the producer",
      );
      assert.deepEqual(
        await markers(),
        [20, 21, 23].map((migration_id) => ({ migration_id })),
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await cli(url, activate);
        assert.equal(
          result.status,
          0,
          "Explicit schema-only activation must succeed with only DATABASE_URL",
        );
        assert.ok(
          result.output.includes("activate the prepared change journal"),
          "The CLI must select the activation job",
        );
        assert.ok(
          result.output.includes("Hosted change journal activated"),
          "Activation must report completion",
        );
        assert.ok(!result.output.includes(url), "Activation must not print the database URL");
      }
      assert.deepEqual(
        await markers(),
        [20, 21, 22, 23].map((migration_id) => ({ migration_id })),
      );
      assert.equal(
        (
          await fixture.query(
            "select to_regprocedure('hosted_record_change(text,text,text)') is not null as retained",
          )
        ).rows[0].retained,
        true,
      );
      assert.deepEqual(
        (
          await fixture.query(
            "select tablename from pg_tables where schemaname='public' order by tablename",
          )
        ).rows.map((row) => row.tablename),
        [
          "executor_apps",
          "hosted_change_batches",
          "hosted_change_dirty",
          "hosted_change_heads",
          "hosted_change_pending",
          "private_hosted_migrations",
        ],
      );
      await fixture.query(
        "update executor_apps set active_deployment='after-cutover' where id='app_fixture'",
      );
      assert.deepEqual(await state(), { logical: "2", physical: "1", dirty: 1, batches: 1 });
      assert.equal(
        (await fixture.query("select hosted_project_changes(100) as projected")).rows[0].projected,
        1,
      );
      assert.deepEqual(await state(), { logical: "2", physical: "2", dirty: 0, batches: 0 });
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      throw new Error(
        "Hosted journal CLI fixture failed. Check isolated Postgres and prepared dependencies.",
      );
    } finally {
      await fixture.end().catch(() => {});
      try {
        if (created)
          await admin.query("drop database " + database + " with (force)").catch(() => {
            throw new Error("Could not remove the owned Hosted journal fixture database");
          });
      } finally {
        await admin.end().catch(() => {});
      }
    }
  },
);
