import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import pg from "pg";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { preludeSchemas } from "./storage-prelude-fixture.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { createRecordedBackup } from "../deploy-safety/contracts.ts";
import {
  beginReleaseDeployment,
  finishDeployment,
  readDeploymentLedger,
} from "../deploy-safety/github-ledger.ts";
import { executorMarkerPolicy } from "../deploy-safety/executor-marker.ts";
import { classifyCurrentRelease, rollForwardTo } from "../deploy-safety/release-plan.ts";
import { executeRelease, type ReleaseDependencies } from "../deploy-safety/release-runner.ts";
import {
  createReleaseLedgerFixture,
  createReleasePlanGitFixture,
} from "./executor-marker-release-fixture.ts";
import { publicCatalogFingerprint } from "./executor-marker-catalog-fixture.ts";

const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
const candidate = "b".repeat(40);
const preludeDatabase = fumadb({ namespace: "executor", schemas: preludeSchemas });
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

function migrate(
  url: string,
  directory: string,
  attempt: string,
  releaseCandidate = candidate,
  markerPolicy = executorMarkerPolicy(releaseCandidate, precondition),
) {
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
      BASALT_RELEASE_CANDIDATE: releaseCandidate,
      BASALT_EXECUTOR_MARKER_POLICY: markerPolicy,
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
  "the strict 4.0.29 retry is held until the product ledger advances the exact candidate",
  { skip: !local },
  async (context) => {
    const f = await fixture();
    const environmentNames = [
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "GITHUB_EVENT_NAME",
      "GITHUB_REF",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
    ] as const;
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
    process.env.GITHUB_TOKEN = "fixture-token";
    process.env.GITHUB_REPOSITORY = "owner/repo";
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    process.env.GITHUB_REF = "refs/heads/main";
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          // Seed the released prelude, not the current initializer: the transition starts at 4.0.29.
          const migrator = yield* preludeDatabase.client(sqlAdapter({ provider: "postgresql" }))
            .createMigrator;
          yield* (yield* migrator.migrateTo("4.0.28")).execute;
          yield* (yield* migrator.up()).execute;
          assert.equal(yield* storage.version, "4.0.29");
        }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(f.url), maxConnections: 1 }))),
      );

      const releaseFixture = await createReleasePlanGitFixture(join(f.directory, "release-plan"));
      const ledgerFixture = createReleaseLedgerFixture(releaseFixture.priorReport);
      const releaseCandidate = releaseFixture.candidate.commit;
      const classificationOptions = {
        fetcher: ledgerFixture.fetcher,
        repositoryRoot: releaseFixture.repositoryRoot,
      };
      const firstPlan = await classifyCurrentRelease(releaseCandidate, classificationOptions);
      assert.equal(firstPlan.report.base.gitCommit, releaseFixture.base.commit);
      assert.equal(firstPlan.report.candidate.gitCommit, releaseCandidate);
      assert.equal(firstPlan.report.databaseChanged, true);
      assert.equal(firstPlan.executorMarker?.expected, "4.0.29");

      const releaseDependencies = (
        deploy: ReleaseDependencies["deploy"],
        smoke: ReleaseDependencies["smoke"],
      ): ReleaseDependencies => ({
        validateCredentials: () => undefined,
        assertBackup: async (report) => createRecordedBackup(report, "main", "PS_5", true),
        begin: (report, backup) =>
          beginReleaseDeployment(
            report,
            ledgerFixture.environment,
            ledgerFixture.fetcher,
            backup,
            rollForwardTo(releaseCandidate, releaseFixture.repositoryRoot),
          ),
        mark: (deploymentId, state) =>
          finishDeployment(deploymentId, state, ledgerFixture.environment, ledgerFixture.fetcher),
        deploy,
        assertImages: async () => ({ started: true, exitCode: 0 }),
        smoke,
      });

      let firstMigration: Awaited<ReturnType<typeof migrate>> | undefined;
      let retryMigration: Awaited<ReturnType<typeof migrate>> | undefined;
      const productRelease = await executeRelease(
        firstPlan.report,
        "manual",
        releaseDependencies(
          async () => {
            const firstAttempt = randomUUID();
            firstMigration = await migrate(
              f.url,
              f.directory,
              firstAttempt,
              releaseCandidate,
              executorMarkerPolicy(releaseCandidate, firstPlan.executorMarker),
            );
            assert.equal(firstMigration.status, 0, firstMigration.output);
            const firstReceipt = JSON.parse(
              await readFile(join(f.directory, `executor-version-${firstAttempt}.json`), "utf8"),
            );
            assert.equal(firstReceipt.outcome, "accepted");
            assert.equal(firstReceipt.observed, "4.0.29");
            assert.equal(await executorVersion(f.client), "4.0.30");

            // While this same product attempt is still in_progress, a fresh plan must keep strict 4.0.29.
            await installNoDdlGuard(f.client);
            const beforeStrictRetry = await publicCatalogFingerprint(f.client);
            const retryPlan = await classifyCurrentRelease(releaseCandidate, classificationOptions);
            assert.equal(retryPlan.ledger.state, "unresolved");
            assert.equal(retryPlan.report.base.gitCommit, releaseFixture.base.commit);
            assert.equal(retryPlan.executorMarker?.expected, "4.0.29");
            const retryAttempt = randomUUID();
            retryMigration = await migrate(
              f.url,
              f.directory,
              retryAttempt,
              releaseCandidate,
              executorMarkerPolicy(releaseCandidate, retryPlan.executorMarker),
            );
            assert.equal(retryMigration.status, 1, retryMigration.output);
            assert.match(retryMigration.output, /migration not started/);
            assert.doesNotMatch(retryMigration.output, /DDL_BEFORE_MARKER_REFUSAL/);
            const retryReceipt = JSON.parse(
              await readFile(join(f.directory, `executor-version-${retryAttempt}.json`), "utf8"),
            );
            assert.equal(retryReceipt.reason, "version_mismatch");
            assert.equal(retryReceipt.observed, "4.0.30");
            assert.equal(await executorVersion(f.client), "4.0.30");
            const afterStrictRetry = await publicCatalogFingerprint(f.client);
            context.diagnostic(
              JSON.stringify({
                phase: "strict retry refused before DDL",
                catalogCounts: catalogCounts(beforeStrictRetry),
                beforeSha256: catalogSha256(beforeStrictRetry),
                afterSha256: catalogSha256(afterStrictRetry),
              }),
            );
            assert.equal(afterStrictRetry, beforeStrictRetry);
            return { started: true, exitCode: 0 };
          },
          async () => ({ started: true, exitCode: 0 }),
        ),
      );
      assert.equal(firstMigration?.status, 0);
      assert.equal(retryMigration?.status, 1);
      assert.deepEqual(productRelease.state, "deployed");

      const advanced = await readDeploymentLedger(ledgerFixture.environment, ledgerFixture.fetcher);
      assert.equal(advanced.state, "ready");
      if (advanced.state !== "ready") return;
      assert.equal(advanced.gitCommit, releaseCandidate);

      const retryPlan = await classifyCurrentRelease(releaseCandidate, classificationOptions);
      assert.equal(retryPlan.report.base.gitCommit, releaseCandidate);
      assert.equal(retryPlan.report.candidate.gitCommit, releaseCandidate);
      assert.equal(retryPlan.report.databaseChanged, false);
      assert.equal(retryPlan.executorMarker, undefined);

      await removeNoDdlGuard(f.client);
      const before = await publicCatalogFingerprint(f.client);
      const catalog = JSON.parse(before) as Record<string, unknown[]>;
      for (const category of [
        "relations",
        "columns",
        "indexes",
        "constraints",
        "triggers",
        "functions",
        "types",
        "sequences",
        "policies",
        "eventTriggers",
      ])
        assert.ok(Array.isArray(catalog[category]), `catalog fingerprint omitted ${category}`);
      for (const category of ["relations", "indexes", "constraints", "triggers"])
        assert.ok(catalog[category]?.length, `public catalog has no ${category}`);
      const finalAttempt = randomUUID();
      const finalRun = await migrate(
        f.url,
        f.directory,
        finalAttempt,
        releaseCandidate,
        executorMarkerPolicy(releaseCandidate, retryPlan.executorMarker),
      );
      assert.equal(finalRun.status, 0, finalRun.output);
      assert.equal(await executorVersion(f.client), "4.0.30");
      const after = await publicCatalogFingerprint(f.client);
      context.diagnostic(
        JSON.stringify({
          phase: "ledger advanced retry made no catalog changes",
          catalogCounts: catalogCounts(before),
          beforeSha256: catalogSha256(before),
          afterSha256: catalogSha256(after),
        }),
      );
      assert.equal(after, before);

      const cloudMigrations = await f.client.query<{ migration_id: number }>(
        "select migration_id from private_cloud_migrations order by migration_id",
      );
      assert.deepEqual(
        cloudMigrations.rows.map((row) => row.migration_id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 19],
      );
      const hostedMigrations = await f.client.query<{ migration_id: number }>(
        "select migration_id from private_hosted_migrations order by migration_id",
      );
      assert.deepEqual(
        hostedMigrations.rows.map((row) => row.migration_id),
        [...Array.from({ length: 21 }, (_, index) => index + 1), 23],
      );
    } finally {
      await removeNoDdlGuard(f.client).catch(() => undefined);
      await f.close();
      for (const name of environmentNames) {
        const previous = previousEnvironment.get(name);
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
  },
);

async function executorVersion(client: pg.Client): Promise<string | undefined> {
  const result = await client.query<{ value: string }>(
    "select value from private_executor_settings where key = 'version'",
  );
  return result.rows[0]?.value;
}

function catalogSha256(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex");
}

function catalogCounts(fingerprint: string): Record<string, number> {
  const catalog = JSON.parse(fingerprint) as Record<string, unknown[]>;
  return Object.fromEntries(
    Object.entries(catalog).map(([category, rows]) => [category, rows.length]),
  );
}

async function installNoDdlGuard(client: pg.Client): Promise<void> {
  await client.query("create table marker_fixture_ddl_guard (armed boolean not null)");
  await client.query("insert into marker_fixture_ddl_guard values (false)");
  await client.query(`create function forbid_marker_fixture_ddl() returns event_trigger
    language plpgsql as $$ begin
      if not (select armed from marker_fixture_ddl_guard) then
        raise exception 'DDL_BEFORE_MARKER_REFUSAL';
      end if;
      return;
    end $$`);
  await client.query(`create event trigger marker_fixture_no_ddl
    on ddl_command_start execute function forbid_marker_fixture_ddl()`);
}

async function removeNoDdlGuard(client: pg.Client): Promise<void> {
  const exists = await client
    .query<{ armed: boolean }>("select armed from marker_fixture_ddl_guard limit 1")
    .catch(() => undefined);
  if (!exists) return;
  await client.query("update marker_fixture_ddl_guard set armed = true");
  await client.query("drop event trigger if exists marker_fixture_no_ddl");
  await client.query("drop function if exists forbid_marker_fixture_ddl()");
  await client.query("drop table marker_fixture_ddl_guard");
}
