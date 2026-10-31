import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

// The real migration job against a local Postgres, with live sessions holding locks it needs.
const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local = adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
const database = `migration_guard_${randomBytes(4).toString("hex")}`;

function databaseUrl() {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

/** `node src/migrate.ts` as the deploy command runs it; resolves with its exit, stderr and duration. */
function migrate(url = databaseUrl()): Promise<{ status: number | null; stderr: string; seconds: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, ["src/migrate.ts"], {
    cwd: cloud,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: url,
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "fixture-only-secret-0123456789abcdef0123",
      GOOGLE_CLIENT_ID: "fixture",
      GOOGLE_CLIENT_SECRET: "fixture",
      GITHUB_CLIENT_ID: "fixture",
      GITHUB_CLIENT_SECRET: "fixture",
    },
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const kill = setTimeout(() => child.kill("SIGKILL"), 120_000);
  return new Promise((done) =>
    child.on("close", (status) => {
      clearTimeout(kill);
      done({ status, stderr, seconds: (Date.now() - started) / 1000 });
    }),
  );
}

/** A live session that took `statement`'s locks and then sat idle in its transaction. */
async function holding(statement: string) {
  const client = new pg.Client({ connectionString: databaseUrl(), application_name: "fixture-app" });
  await client.connect();
  await client.query("begin");
  await client.query(statement);
  return { release: () => client.query("rollback").finally(() => client.end()) };
}

test("the migration job fails fast and names the step when live sessions hold its locks", { skip: !local }, async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${database}`);
  try {
    const fresh = await migrate();
    assert.equal(fresh.status, 0, fresh.stderr);
    const repeat = await migrate();
    assert.equal(repeat.status, 0, repeat.stderr);

    // The migration session's journal lock, behind a transaction left open by another client.
    const journal = await holding("select migration_id from private_hosted_migrations where migration_id = 1");
    try {
      const run = await migrate();
      assert.equal(run.status, 1);
      assert.ok(run.seconds < 60, `took ${run.seconds}s`);
      assert.match(run.stderr, /Cloud migration failed at "run the hosted product steps" \(attempt 1 of 2\): lock timeout \(55P03\)/);
      assert.match(run.stderr, /Retrying in 2s on fresh sessions/);
      assert.match(run.stderr, /failed at "run the hosted product steps" \(attempt 2 of 2\): lock timeout \(55P03\)/);
      assert.match(
        run.stderr,
        /Blocker report: open transaction pid \d+: idle in transaction, .*application fixture-app, same login: select migration_id from private_hosted_migrations where migration_id = \?/,
      );
    } finally {
      await journal.release();
    }

    // Better Auth's own session used to wait here without any limit.
    const resources = await holding('lock table "oauthResource" in access exclusive mode');
    try {
      const run = await migrate();
      assert.equal(run.status, 1);
      assert.ok(run.seconds < 60, `took ${run.seconds}s`);
      assert.match(run.stderr, /Migration step \(attempt 1\): provision the OAuth resources/);
      assert.match(run.stderr, /Cloud migration failed at "provision the OAuth resources" \(attempt 1 of 2\)/);
      assert.doesNotMatch(run.stderr, /fixture-only/);
    } finally {
      await resources.release();
    }

    const after = await migrate();
    assert.equal(after.status, 0, after.stderr);
  } finally {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

test("executor migration failures retain safe codes and versions without SQL or driver text", { skip: !local }, async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const target = `${database}_diagnostics`;
  await admin.query(`create database ${target}`);
  const fixtureUrl = new URL(databaseUrl());
  fixtureUrl.pathname = `/${target}`;
  const fixture = new pg.Client({ connectionString: fixtureUrl.toString() });
  try {
    // Use the deploy entrypoint against this separate fixture database.
    const first = await migrate(fixtureUrl.toString());
    assert.equal(first.status, 0, first.stderr);
    await fixture.connect();
    const { rows: [original] } = await fixture.query<{ value: string }>(
      "select value from private_executor_settings where key = 'version'",
    );
    assert.ok(original);
    await fixture.query("update private_executor_settings set value = '4.0.1' where key = 'version'");
    await fixture.query(`create function reject_fixture_upgrade() returns event_trigger language plpgsql as $$
      begin raise exception using errcode = 'P0001', message = 'SYNTHETIC_DRIVER_SECRET',
        detail = 'SYNTHETIC_PARAMETER_SECRET'; end $$`);
    await fixture.query("create event trigger reject_fixture_upgrade on ddl_command_start execute function reject_fixture_upgrade()");
    const failed = await migrate(fixtureUrl.toString());
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /migrate the executor tables/);
    assert.match(failed.stderr, /executor version 4\.0\.2/);
    assert.match(failed.stderr, /StorageMigrationFailed.*MigrationError.*SqlError/);
    assert.match(failed.stderr, /SQLSTATE P0001/);
    assert.doesNotMatch(failed.stderr, /SYNTHETIC_DRIVER_SECRET|SYNTHETIC_PARAMETER_SECRET|Failed to execute migration statement|ADD COLUMN/);
    assert.equal((await fixture.query("select value from private_executor_settings where key = 'version'")).rows[0].value, "4.0.1");
    await fixture.query("drop event trigger reject_fixture_upgrade");
    await fixture.query("update private_executor_settings set value = $1 where key = 'version'", [original.value]);
    const recovered = await migrate(fixtureUrl.toString());
    assert.equal(recovered.status, 0, recovered.stderr);
  } finally {
    await fixture.end();
    await admin.query(`drop database if exists ${target} with (force)`);
    await admin.end();
  }
});
