import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import pg from "pg";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { executorMarkerPolicy } from "../deploy-safety/executor-marker.ts";

const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
const candidate = "b".repeat(40);
const precondition = {
  transition: {
    baseGitCommit: "a".repeat(40),
    candidateGitCommit: candidate,
    baseToolsCommit: "f69c667936e4c02c75f9d7cc79fb750c230839b9",
    candidateToolsCommit: "2f4c398f3906e0570f0e25a16fa3602329baba29",
  },
  marker: "public.private_executor_settings.key=version",
  expected: "4.0.29",
} as const;

async function fixture() {
  const database = `executor_marker_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const target = new URL(adminUrl!);
  target.pathname = `/${database}`;
  const url = target.toString();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const directory = await mkdtemp(join(tmpdir(), "executor-marker-"));
  return {
    url,
    client,
    directory,
    close: async () => {
      await client.end();
      await admin.query(`drop database ${database} with (force)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function migrate(url: string, directory: string, attempt: string) {
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
      BASALT_RELEASE_ATTEMPT: attempt,
      BASALT_RELEASE_CANDIDATE: candidate,
      BASALT_EXECUTOR_MARKER_POLICY: executorMarkerPolicy(candidate, precondition),
      BASALT_RELEASE_EVIDENCE_DIRECTORY: directory,
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

const schema = async (client: pg.Client) =>
  (
    await client.query<{ relname: string; relkind: string; oid: number }>(
      "select c.relname, c.relkind, c.oid::int as oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' order by c.relname, c.relkind",
    )
  ).rows;

for (const { name, values, reason } of [
  { name: "missing table", values: undefined, reason: "query_failed" },
  { name: "missing row", values: [], reason: "missing" },
  { name: "old marker", values: ["4.0.28"], reason: "version_mismatch" },
  { name: "duplicate marker", values: ["4.0.29", "4.0.29"], reason: "multiple_rows" },
  { name: "unnormalized marker", values: ["4.0.29 "], reason: "invalid_value" },
])
  test(`the real migration command refuses ${name} before any DDL`, { skip: !local }, async () => {
    const f = await fixture();
    try {
      if (values !== undefined) {
        await f.client.query("create table private_executor_settings (key text, value text)");
        for (const value of values)
          await f.client.query("insert into private_executor_settings values ('version', $1)", [
            value,
          ]);
      }
      // If the command enters migrations first, this exception replaces the expected marker refusal.
      await f.client.query(`create function forbid_marker_fixture_ddl() returns event_trigger
        language plpgsql as $$ begin raise exception 'DDL_BEFORE_MARKER_REFUSAL'; end $$`);
      await f.client.query(`create event trigger marker_fixture_no_ddl
        on ddl_command_start execute function forbid_marker_fixture_ddl()`);
      const before = await schema(f.client);
      const attempt = randomUUID();
      const run = await migrate(f.url, f.directory, attempt);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /migration not started/);
      assert.doesNotMatch(run.output, /DDL_BEFORE_MARKER_REFUSAL|fixture-only/);
      assert.deepEqual(await schema(f.client), before);
      const receipt = JSON.parse(
        await readFile(join(f.directory, `executor-version-${attempt}.json`), "utf8"),
      );
      assert.equal(receipt.reason, reason);
      assert.equal(receipt.outcome, reason === "query_failed" ? "read_failed" : "refused");
      assert.deepEqual(receipt.transition, precondition.transition);
      assert.equal(receipt.attempt, attempt);
    } finally {
      await f.close();
    }
  });

test(
  "an unretained marker receipt blocks the real command before DDL",
  { skip: !local },
  async () => {
    const f = await fixture();
    try {
      await f.client.query("create table private_executor_settings (key text, value text)");
      await f.client.query("insert into private_executor_settings values ('version', '4.0.29')");
      const before = await schema(f.client);
      const blocked = join(f.directory, "receipt-file");
      await writeFile(blocked, "fixture");
      const run = await migrate(f.url, blocked, randomUUID());
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /receipt could not be retained; migration not started/);
      assert.deepEqual(await schema(f.client), before);
    } finally {
      await f.close();
    }
  },
);

test(
  "the exact prelude marker admits real Cloud migrations and a fresh retry",
  { skip: !local },
  async () => {
    const f = await fixture();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          assert.equal(yield* storage.version, "4.0.29");
        }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(f.url), maxConnections: 1 }))),
      );
      let first: Awaited<ReturnType<typeof schema>> | undefined;
      for (let retry = 0; retry < 2; retry++) {
        const attempt = randomUUID();
        const run = await migrate(f.url, f.directory, attempt);
        assert.equal(run.status, 0, run.output);
        const receipt = JSON.parse(
          await readFile(join(f.directory, `executor-version-${attempt}.json`), "utf8"),
        );
        assert.equal(receipt.outcome, "accepted");
        assert.equal(receipt.observed, "4.0.29");
        assert.deepEqual(receipt.transition, precondition.transition);
        assert.equal(receipt.attempt, attempt);
        assert.deepEqual(
          (
            await f.client.query(
              "select migration_id from private_cloud_migrations order by migration_id",
            )
          ).rows.map((row) => row.migration_id),
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 19],
        );
        assert.deepEqual(
          (
            await f.client.query(
              "select migration_id from private_hosted_migrations order by migration_id",
            )
          ).rows.map((row) => row.migration_id),
          Array.from({ length: 18 }, (_, index) => index + 1),
        );
        const current = await schema(f.client);
        if (first)
          assert.deepEqual(
            current,
            first,
            "retry must preserve physical table and index identities",
          );
        first = current;
      }
    } finally {
      await f.close();
    }
  },
);
