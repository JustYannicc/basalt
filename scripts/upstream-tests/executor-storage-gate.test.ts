import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import pg from "pg";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { publicCatalogFingerprint } from "./executor-marker-catalog-fixture.ts";
import { preludeSchemas } from "./storage-prelude-fixture.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import {
  admitExecutorStorage,
  requiredExecutorStorage,
} from "../../.upstream/apps/hosted/cloud/src/implementation/executor-version-gate.ts";

test("the storage gate admits a fresh database and the prelude or later, nothing older", () => {
  assert.equal(requiredExecutorStorage, "4.0.29");
  assert.deepEqual(admitExecutorStorage(undefined), { outcome: "fresh" });
  assert.deepEqual(admitExecutorStorage([]), { outcome: "fresh" });
  for (const value of ["4.0.29", "4.0.30", "4.1.0", "5.0.0"])
    assert.deepEqual(admitExecutorStorage([{ value }]), { outcome: "accepted", observed: value });
  for (const value of ["4.0.28", "4.0.3", "3.9.99"])
    assert.deepEqual(admitExecutorStorage([{ value }]), {
      outcome: "refused",
      reason: "below_prelude",
      observed: value,
    });
  for (const value of ["4.0.29 ", "v4.0.29", 429, null])
    assert.equal(admitExecutorStorage([{ value }]).outcome, "refused");
  assert.deepEqual(admitExecutorStorage([{ value: "4.0.29" }, { value: "4.0.29" }]), {
    outcome: "refused",
    reason: "multiple_rows",
    observed: null,
  });
});

const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
const preludeDatabase = fumadb({ namespace: "executor", schemas: preludeSchemas });
const journals = JSON.parse(
  readFileSync(new URL("./migration-journals.json", import.meta.url), "utf8"),
) as Record<"private_hosted_migrations" | "private_cloud_migrations", string[]>;
const ids = (keys: readonly string[]) => keys.map((key) => Number(key.split("_", 1)[0]));
// Hosted step 22 is the change journal's explicit activation, which a plain migration never runs.
const hostedSteps = ids(
  journals.private_hosted_migrations.filter((key) => key !== "22_change_journal_activate"),
);
// Upstream's Cloud steps 8 to 13 run under the ids the list gives them (carry 0475).
const cloudSteps = ids(journals.private_cloud_migrations);

async function database() {
  const name = `executor_storage_gate_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(adminUrl!);
  target.pathname = `/${name}`;
  const url = target.toString();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    url,
    client,
    close: async () => {
      await client.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

/** The real migration command, as the stack's migration job runs it: no release policy inputs. */
function migrate(url: string) {
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
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

const relations = async (client: pg.Client) =>
  (
    await client.query<{ relname: string; relkind: string; oid: number }>(
      "select c.relname, c.relkind, c.oid::int as oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' order by c.relname, c.relkind",
    )
  ).rows;

const journal = async (client: pg.Client, table: string) =>
  (
    await client.query<{ migration_id: number }>(
      `select migration_id from ${table} order by migration_id`,
    )
  ).rows.map((row) => row.migration_id);

const storageVersion = async (client: pg.Client) =>
  (
    await client.query<{ value: string }>(
      "select value from private_executor_settings where key = 'version'",
    )
  ).rows[0]?.value;

/** Seed the released prelude, not the current initializer: the transition starts at 4.0.29. */
const seedPrelude = (url: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      const migrator = yield* preludeDatabase.client(sqlAdapter({ provider: "postgresql" }))
        .createMigrator;
      yield* (yield* migrator.migrateTo("4.0.28")).execute;
      yield* (yield* migrator.up()).execute;
      assert.equal(yield* storage.version, "4.0.29");
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))),
  );

for (const { name, values } of [
  { name: "storage older than the prelude", values: ["4.0.28"] },
  { name: "a duplicated storage marker", values: ["4.0.29", "4.0.29"] },
  { name: "an unnormalized storage marker", values: ["4.0.29 "] },
])
  test(`the real migration command refuses ${name} before any DDL`, { skip: !local }, async () => {
    const f = await database();
    try {
      await f.client.query("create table private_executor_settings (key text, value text)");
      for (const value of values)
        await f.client.query("insert into private_executor_settings values ('version', $1)", [
          value,
        ]);
      // If the command reached migrations first, this exception would replace the refusal.
      await f.client.query(`create function forbid_gate_fixture_ddl() returns event_trigger
        language plpgsql as $$ begin raise exception 'DDL_BEFORE_STORAGE_REFUSAL'; end $$`);
      await f.client.query(`create event trigger gate_fixture_no_ddl
        on ddl_command_start execute function forbid_gate_fixture_ddl()`);
      const before = await relations(f.client);
      const run = await migrate(f.url);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /is not at least 4\.0\.29; migration not started/);
      assert.doesNotMatch(run.output, /DDL_BEFORE_STORAGE_REFUSAL|fixture-only/);
      assert.deepEqual(await relations(f.client), before);
    } finally {
      await f.close();
    }
  });

test(
  "a fresh database runs every hosted and Cloud step, and a second run changes nothing",
  { skip: !local },
  async () => {
    const f = await database();
    try {
      const first = await migrate(f.url);
      assert.equal(first.status, 0, first.output);
      assert.deepEqual(await journal(f.client, "private_hosted_migrations"), hostedSteps);
      assert.deepEqual(await journal(f.client, "private_cloud_migrations"), cloudSteps);
      const before = await publicCatalogFingerprint(f.client);
      const second = await migrate(f.url);
      assert.equal(second.status, 0, second.output);
      assert.equal(await publicCatalogFingerprint(f.client), before);
    } finally {
      await f.close();
    }
  },
);

test(
  "a database at the released prelude migrates every step once, and a retry changes nothing",
  { skip: !local },
  async () => {
    const f = await database();
    try {
      await seedPrelude(f.url);
      const first = await migrate(f.url);
      assert.equal(first.status, 0, first.output);
      assert.equal(await storageVersion(f.client), "4.0.30");
      assert.deepEqual(await journal(f.client, "private_hosted_migrations"), hostedSteps);
      assert.deepEqual(await journal(f.client, "private_cloud_migrations"), cloudSteps);
      // A retry of the same release, as after a failed apply, admits 4.0.30 and runs no DDL change.
      const before = await publicCatalogFingerprint(f.client);
      const retry = await migrate(f.url);
      assert.equal(retry.status, 0, retry.output);
      assert.equal(await publicCatalogFingerprint(f.client), before);
    } finally {
      await f.close();
    }
  },
);

test(
  "a release stopped at a bridged Cloud step commits no product step, and its retry completes",
  { skip: !local },
  async () => {
    const f = await database();
    try {
      await seedPrelude(f.url);
      // The first bridged Cloud step fails, as if the earlier attempt stopped there.
      await f.client.query(`create function fail_bridge_fixture() returns event_trigger
        language plpgsql as $$ begin
          if exists (select 1 from pg_event_trigger_ddl_commands()
            where object_identity like '%private_v1_session_handoff%') then
            raise exception 'BRIDGE_FIXTURE_STOP';
          end if;
        end $$`);
      await f.client.query(`create event trigger bridge_fixture_stop
        on ddl_command_end execute function fail_bridge_fixture()`);
      const stopped = await migrate(f.url);
      assert.equal(stopped.status, 1, stopped.output);
      assert.match(stopped.output, /run the cloud product steps/);
      // Product steps share one transaction: the stop leaves the prelude's storage, and the
      // bridged step's table does not exist half-made.
      assert.equal(await storageVersion(f.client), "4.0.29");
      const handoffs = await f.client.query<{ present: boolean }>(
        "select to_regclass('public.private_v1_session_handoff') is not null as present",
      );
      assert.equal(handoffs.rows[0]?.present, false);
      await f.client.query("drop event trigger bridge_fixture_stop");
      const retry = await migrate(f.url);
      assert.equal(retry.status, 0, retry.output);
      assert.equal(await storageVersion(f.client), "4.0.30");
      assert.deepEqual(await journal(f.client, "private_cloud_migrations"), cloudSteps);
      assert.deepEqual(await journal(f.client, "private_hosted_migrations"), hostedSteps);
    } finally {
      await f.close();
    }
  },
);
