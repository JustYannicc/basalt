import { historyImportCompletionPath } from "../../src/pool/model-history/import-completion-contract.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { historyApplyFailure } from "../../src/pool/model-history/operator-failure.ts";
import pg from "pg";
import {
  handleModelHistoryOperation,
  historyBackfillPath,
  historySchemaCatalogPath,
  historyJournalActivationPath,
  historyJournalReaderVersion,
} from "../../src/pool/model-history/operator.ts";
import { withHistoryDatabase } from "../../src/pool/model-history/database.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";

// The schema apply route that predates release-only history steps.
const removedSchemaApplyPath = "/model-history/schema";
import {
  historyJournalPrepareVersion,
  historyJournalActivateVersion,
} from "../../src/pool/model-history/change-journal-schema.ts";
import { loadMiniflare } from "../startup-profiler/profile.ts";
import { readBundle } from "../worker-startup.ts";
import { historyTrafficPath } from "../../src/pool/model-history/traffic.ts";
import { historyUsageRollupPath } from "../../src/pool/model-history/usage-rollup-backfill.ts";

const expectedTables = [
  "basalt_model_history_migrations",
  "basalt_model_requests",
  ...Array.from({ length: 16 }, (_, part) => `basalt_model_requests_${part}`),
  "basalt_model_history_cursor",
  "basalt_model_traffic",
  "basalt_pool_change_heads",
  "basalt_pool_change_pending",
  "basalt_pool_change_batches",
  "basalt_pool_change_dirty",
  "basalt_model_import_jobs",
  "basalt_model_import_receipts",
  "basalt_model_terminal_starts",
  "basalt_model_terminal_finishes",
  "basalt_model_import_completion",
  "basalt_model_import_reconcile",
  "basalt_model_usage_hourly",
  "basalt_model_usage_hours",
  "basalt_model_usage_ready",
  "basalt_model_usage_people_hourly",
  "basalt_model_usage_people_hours",
  "basalt_model_usage_people_ready",
].sort();

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to isolated local test Postgres");

test("the private schema operator reads catalogs and counts and has no schema apply route", async () => {
  // CI runs this before the application build, so the fixture owns its deployment bundle.
  execFileSync("bun", ["scripts/pool-worker-build.ts"], { stdio: "inherit" });
  const database = `operator_${randomUUID().replaceAll("-", "")}`;
  const administration = new pg.Client({ connectionString: adminUrl });
  await administration.connect();
  await administration.query(
    "DO $$ BEGIN CREATE ROLE basalt_pool_owner NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
  );
  await administration.query(`CREATE DATABASE ${database} OWNER basalt_pool_owner`);
  const direct = new URL(adminUrl!);
  direct.pathname = "/" + database;
  const db = new pg.Client({ connectionString: direct.toString() });
  const schema = "public";
  await db.connect();
  try {
    await db.query("SET ROLE basalt_pool_owner");
    await db.query("CREATE TABLE usage (id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL)");
    await db.query(
      "INSERT INTO usage (timestamp) VALUES ('2020-01-01T00:00:00Z'),('2020-01-02T00:00:00Z')",
    );
    await db.query("CREATE TABLE home_data_migration (name text,completed boolean)");
    await db.query(
      "INSERT INTO home_data_migration VALUES ('diagnostics_metadata_only_v1_1_6',true)",
    );
    await db.query("RESET ROLE");
    const url = new URL(process.env.POOL_TEST_POOLED_URL ?? adminUrl!);
    url.pathname = "/" + database;
    url.searchParams.delete("options");
    const before = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
      [schema],
    );
    const bundle = readBundle("PoolWorker", ".alchemy/bundles/PoolWorker");
    const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
    const worker = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "pool",
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            modulesRoot: "/",
            modules: bundle.modules.map((file) => ({
              type: file.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
              path: join(bundle.directory, file),
              contents: readFileSync(join(bundle.directory, file)),
            })),
            bindings: {
              POOL_DATABASE_URL: url.toString(),
              POOL_MANAGEMENT_KEY: "fixture-management",
              POOL_IMAGE_HASH: "fixture",
              POOL_APP_SIGNING_KEY: "ab".repeat(32),
            },
            hyperdrives: { POOL_AUTH_DATABASE: url.toString() },
            durableObjects: { PoolContainer: { className: "PoolContainer", useSQLite: true } },
          },
          {
            name: "operator",
            compatibilityDate: "2026-09-08",
            modules: true,
            script:
              "export default { fetch(request, env) { return env.POOL_OPERATIONS.fetch(request); } };",
            serviceBindings: { POOL_OPERATIONS: { name: "pool", entrypoint: "PoolOperations" } },
          },
        ],
      }),
    );
    try {
      await worker.ready;
      const publicPool = await worker.getWorker("pool");
      // Every operation the history operator handles. The private entrypoint routes each one and
      // the public Worker refuses each one; an operation added to one list and not the other
      // shows here.
      const operationPaths = [
        historySchemaCatalogPath,
        historyJournalActivationPath,
        historyBackfillPath,
        historyTrafficPath,
        historyImportCompletionPath,
        historyUsageRollupPath,
      ];
      for (const path of [...operationPaths, removedSchemaApplyPath]) {
        const response = await publicPool.fetch(`http://pool${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ go: true }),
        });
        assert.equal(
          response.status,
          404,
          "operator actions must not be exposed by the public Worker",
        );
        await response.body?.cancel();
      }
      const operator = await worker.getWorker("operator");
      const activation = await operator.fetch(`http://operator${historyJournalActivationPath}`);
      assert.equal(activation.status, 200, await activation.clone().text());
      const activationPlan = await activation.json();
      assert.equal(activationPlan.writes, false);
      assert.equal(activationPlan.readersReadyRequired, historyJournalReaderVersion);
      assert.deepEqual(activationPlan.catalogDiff.conflicts, [
        `Requires ${historyJournalPrepareVersion} before activation`,
      ]);
      const catalog = await operator.fetch(`http://operator${historySchemaCatalogPath}`);
      assert.equal(catalog.status, 200, await catalog.clone().text());
      const preview = await catalog.json();
      assert.equal(preview.writes, false);
      assert.equal(preview.history.rows, "2");
      assert.equal(preview.history.privacyReady, true);
      assert.deepEqual([...preview.catalogDiff.createTables].sort(), expectedTables);
      const backfill = await operator.fetch(`http://operator${historyBackfillPath}`);
      assert.equal(backfill.status, 200, await backfill.clone().text());
      assert.equal((await backfill.json()).writes, false);
      // Before v15 is applied the usage rollup's dry run refuses with the handler's own 503.
      const rollup = await operator.fetch(`http://operator${historyUsageRollupPath}`);
      assert.equal(rollup.status, 503, "the private operator reaches the usage rollup's handler");
      await rollup.body?.cancel();
      for (const path of operationPaths) {
        const routed = await operator.fetch(`http://operator${path}`);
        assert.notEqual(routed.status, 404, `the private operator routes ${path}`);
        await routed.body?.cancel();
      }
    } finally {
      await worker.dispose();
    }
    assert.deepEqual(
      (
        await db.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [
          schema,
        ])
      ).rows,
      before.rows,
      "starting the deployed Worker must not create or migrate history tables",
    );
    assert.equal(
      (await db.query("SELECT count(*)::text AS rows FROM usage")).rows[0].rows,
      "2",
      "Worker deployment must leave existing Home history untouched",
    );
    const invoke = (path: string, body?: object) =>
      handleModelHistoryOperation(
        new Request(
          `http://operator${path}`,
          body
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }
            : {},
        ),
        url.toString(),
      );
    // Schema steps are applied only by the release's database step, so even an approval that
    // matches the current plan finds no apply route and writes nothing.
    const current = await (await invoke(historySchemaCatalogPath)).json();
    const removed = await invoke(removedSchemaApplyPath, {
      go: true,
      schemaHash: current.schemaHash,
      catalogHash: current.catalogHash,
    });
    assert.equal(removed.status, 404);
    assert.equal(
      (await db.query("SELECT to_regclass('basalt_model_requests') AS name")).rows[0].name,
      null,
      "the removed apply route creates no history schema",
    );
    const dry = await invoke(historySchemaCatalogPath);
    assert.equal(dry.status, 200, await dry.clone().text());
    const plan = (await dry.json()) as {
      schemaHash: string;
      catalogHash: string;
      writes: boolean;
      applied: boolean;
      history: { rows: string; privacyReady: boolean };
      ledgerRows: string;
      catalogDiff: { createTables: string[] };
    };
    assert.equal(plan.writes, false);
    assert.equal(plan.history.rows, "2");
    assert.equal(plan.history.privacyReady, true);
    assert.equal(plan.ledgerRows, "0");
    assert.deepEqual([...plan.catalogDiff.createTables].sort(), expectedTables);
    assert.equal(
      (await db.query("SELECT to_regclass('basalt_model_requests') AS name")).rows[0].name,
      null,
    );
    // The release's database step runs this migrator.
    await withHistoryDatabase(url.toString(), (history) => migrateModelHistory(history));
    assert.equal(
      (await db.query("SELECT count(*)::text AS rows FROM basalt_model_requests")).rows[0].rows,
      "0",
      "schema application must not backfill metadata silently",
    );
    const refreshed = (await (await invoke(historySchemaCatalogPath)).json()) as typeof plan;
    assert.equal(refreshed.applied, true);
    assert.equal(refreshed.catalogDiff.createTables.length, 0);
    assert.equal(refreshed.writes, false);
    assert.equal(
      (
        await db.query("SELECT name FROM basalt_model_history_migrations WHERE name=$1", [
          historyJournalActivateVersion,
        ])
      ).rows.length,
      0,
      "normal schema apply prepares readers without activating the queue producer",
    );
    const activation = await (await invoke(historyJournalActivationPath)).json();
    const cutover = {
      go: true,
      schemaHash: activation.schemaHash,
      catalogHash: activation.catalogHash,
    };
    assert.equal((await invoke(historyJournalActivationPath, cutover)).status, 400);
    const acknowledged = { ...cutover, readersReady: historyJournalReaderVersion };
    assert.equal(
      (await invoke(historyJournalActivationPath, { ...acknowledged, schemaHash: "0".repeat(64) }))
        .status,
      409,
      "an approval for another manifest never activates",
    );
    assert.equal((await (await invoke(historyJournalActivationPath)).json()).applied, false);
    // A failed activation answers with an empty 503 and logs only closed diagnostics.
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const failed = await handleModelHistoryOperation(
        new Request(`http://operator${historyJournalActivationPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(acknowledged),
        }),
        "postgresql://fixture:private-secret@127.0.0.1:1/unreachable",
      );
      assert.equal(failed.status, 503);
      assert.equal(await failed.text(), "");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]![0], "Model history journal activation failed");
      assert.doesNotMatch(JSON.stringify(errors), /private-secret|fixture:/u);
    } finally {
      console.error = originalError;
    }
    assert.equal((await invoke(historyJournalActivationPath, acknowledged)).status, 200);
    assert.equal((await (await invoke(historyJournalActivationPath)).json()).applied, true);
    assert.equal(
      (await db.query("SELECT count(*)::text AS rows FROM basalt_model_history_cursor")).rows[0]
        .rows,
      "0",
      "schema application must not activate capture",
    );
    const backfill = (await (await invoke(historyBackfillPath)).json()) as {
      digest: string;
      plan: object;
      writes: boolean;
    };
    assert.equal(backfill.writes, false);
    assert.equal((await invoke(historyBackfillPath, { ...backfill, go: false })).status, 400);
    assert.equal(
      (await invoke(historyBackfillPath, { ...backfill, digest: "0".repeat(64), go: true })).status,
      409,
    );
    assert.equal(
      (await db.query("SELECT count(*)::text AS rows FROM basalt_model_history_cursor")).rows[0]
        .rows,
      "0",
    );
    await db.query("UPDATE home_data_migration SET completed=false");
    assert.equal(
      (await invoke(historyBackfillPath, { ...backfill, go: true })).status,
      503,
      "privacy readiness must still hold when an approved plan activates",
    );
    await db.query("UPDATE home_data_migration SET completed=true");
    assert.equal((await invoke(historyBackfillPath, { ...backfill, go: true })).status, 200);
    assert.equal(
      (
        await db.query(
          "SELECT backfill_id::text AS start,backfill_upper::text AS upper_id FROM basalt_model_history_cursor",
        )
      ).rows[0].start,
      "0",
    );
    assert.equal(
      (await db.query("SELECT backfill_upper::text AS upper_id FROM basalt_model_history_cursor"))
        .rows[0].upper_id,
      "2",
    );
    assert.equal(
      (await db.query("SELECT count(*)::text AS rows FROM basalt_model_requests")).rows[0].rows,
      "0",
      "activation schedules bounded collection without copying rows in the operator request",
    );
  } finally {
    await db.end();
    await administration.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await administration.end();
  }
});

test("activation apply diagnostics discard driver messages, credentials and nested causes", () => {
  const secret = "postgres://secret-user:secret-password@private-host/private-db";
  for (const code of ["42501", "ECONNREFUSED", "EPIPE", "arbitrary-secret-code"]) {
    const error = Object.assign(new Error(secret), {
      code,
      detail: secret,
      hint: secret,
      cause: new Error(secret),
    });
    const diagnostic = historyApplyFailure(error);
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
    assert.deepEqual(
      diagnostic,
      code === "42501"
        ? { type: "PostgresError", code }
        : code === "arbitrary-secret-code"
          ? { type: "UnknownError" }
          : { type: "ConnectionError", code },
    );
  }
});
