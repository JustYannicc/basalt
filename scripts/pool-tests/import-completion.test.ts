import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHistoryOperator, historyOperatorOptions } from "../pool-history-operator.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { homeMetadataFixture } from "./history-fixture.ts";
import {
  handleModelHistoryOperation,
  modelHistorySchemaPlan,
} from "../../src/pool/model-history/operator.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import {
  historySchemaMigrations,
  migrateModelHistory,
} from "../../src/pool/model-history/schema.ts";
import { historyImportCompletionVersion } from "../../src/pool/model-history/import-completion-schema.ts";
import {
  importCompletionScope,
  type ImportCompletionSelection,
} from "../../src/pool/model-history/import-completion-contract.ts";
import { authority, input, pool, seriesFixture } from "./series-fixture.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function idsDigest(ids: string[]) {
  const prefixes = [...new Set(ids.map((id) => id.slice(0, 2)))].sort();
  return sha(
    prefixes
      .map(
        (prefix) =>
          `${prefix}:${sha(
            ids
              .filter((id) => id.startsWith(prefix))
              .sort()
              .join("\n"),
          )}`,
      )
      .join("\n"),
  );
}
function connection(schema: string) {
  const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
const source = "11111111-2222-4333-8444-555555555555";
const at = "2026-01-01T00:45:00.000000000Z";
const seed = {
  pool,
  source,
  frozenFrom: at,
  frozenTo: at,
  afterSourceId: "0",
  upperSourceId: "2",
  manifestDigest: sha("manifest"),
  accountMappingDigest: sha("map"),
  verifiedRows: "2",
};
async function operation(
  schema: string,
  selection: unknown,
  approval?: { digest: unknown; go: boolean },
) {
  return handleModelHistoryOperation(
    new Request("http://private-operations/model-history/import-completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection, ...approval }),
    }),
    connection(schema),
  );
}

test("private import completion reconciles exact IDs and keeps replay and contiguous top-ups durable in public coverage", async () => {
  await seriesFixture(async ({ db, schema, insert }) => {
    const scope = await importCompletionScope({ pool, source });
    const rows = await insert({ source: scope.source }, { source: scope.source });
    const selection = { ...seed, idsDigest: idsDigest(rows.map((row) => row.id)) };
    const preview = await operation(schema, selection);
    assert.equal(preview.status, 200, await preview.clone().text());
    const plan = await preview.json();
    assert.equal(plan.reconciled, true);
    assert.equal(plan.contiguous, true);
    assert.equal(plan.writes, false);
    assert.equal((await db.query("SELECT * FROM basalt_model_import_completion")).rows.length, 0);
    let series = await poolUsageSeries(db, input, authority);
    assert.equal(series.coverage.sources[0]!.backfillComplete, false);
    assert.equal(series.coverage.sources[0]!.completion, undefined);
    assert.equal(
      (await operation(schema, selection, { digest: sha("wrong"), go: true })).status,
      409,
    );
    const done = await operation(schema, selection, { digest: plan.digest, go: true });
    assert.equal(done.status, 200, await done.clone().text());
    const retained = (
      await db.query("SELECT row_to_json(c)::text AS row FROM basalt_model_import_completion c")
    ).rows;
    series = await poolUsageSeries(db, input, authority);
    assert.equal(series.coverage.sources[0]!.backfillComplete, true);
    assert.deepEqual(series.coverage.sources[0]!.completion, {
      frozenFrom: at,
      frozenTo: at,
      upperSourceId: "2",
      manifestDigest: seed.manifestDigest,
      accountMappingDigest: seed.accountMappingDigest,
      idsDigest: selection.idsDigest,
      verifiedRows: "2",
    });
    assert.equal((await db.query("SELECT * FROM basalt_model_history_cursor")).rows.length, 0);
    assert.equal(
      (await poolUsageSeries(db, { ...input, pool: "another-pool" }, authority)).coverage.sources
        .length,
      0,
    );
    const replay = await (await operation(schema, selection)).json();
    assert.equal(replay.alreadyComplete, true);
    assert.equal(
      (await operation(schema, selection, { digest: replay.digest, go: true })).status,
      200,
    );
    assert.deepEqual(
      (await db.query("SELECT row_to_json(c)::text AS row FROM basalt_model_import_completion c"))
        .rows,
      retained,
    );
    const nextRows = await insert({
      source: scope.source,
      timestamp: "2026-01-01T01:45:00.000000000Z",
    });
    const next: ImportCompletionSelection = {
      ...selection,
      frozenTo: "2026-01-01T01:45:00.000000000Z",
      afterSourceId: "2",
      upperSourceId: "3",
      manifestDigest: sha("tail"),
      idsDigest: idsDigest([...rows, ...nextRows].map((row) => row.id)),
      verifiedRows: "3",
    };
    const gap = { ...next, afterSourceId: "1" };
    const gapPlan = await (await operation(schema, gap)).json();
    assert.equal(gapPlan.contiguous, false);
    assert.equal((await operation(schema, gap, { digest: gapPlan.digest, go: true })).status, 409);
    const nextPlan = await (await operation(schema, next)).json();
    assert.equal(nextPlan.reconciled, true);
    assert.equal(
      (await operation(schema, next, { digest: nextPlan.digest, go: true })).status,
      200,
    );
    assert.equal(
      (await poolUsageSeries(db, input, authority)).coverage.sources[0]!.completion!.upperSourceId,
      "3",
    );
    const rewind = await (await operation(schema, selection)).json();
    assert.equal(
      (await operation(schema, selection, { digest: rewind.digest, go: true })).status,
      409,
    );
  });
});

test("equal counts cannot finalize changed IDs, ranges, pools or a source altered after review", async () => {
  await seriesFixture(async ({ db, schema, insert }) => {
    const scope = await importCompletionScope({ pool, source });
    const rows = await insert({ source: scope.source }, { source: scope.source });
    const selection = { ...seed, idsDigest: idsDigest(rows.map((row) => row.id)) };
    for (const changed of [
      { ...selection, idsDigest: idsDigest([rows[0]!.id, sha("different")]) },
      { ...selection, frozenFrom: "2026-01-01T00:44:00.000000000Z" },
      { ...selection, pool: "another-pool" },
      { ...selection, verifiedRows: "1" },
    ]) {
      const preview = await (await operation(schema, changed)).json();
      assert.equal(preview.reconciled, false);
      const refused = await operation(schema, changed, { digest: preview.digest, go: true });
      assert.equal(refused.status, 409);
      assert.ok((await refused.json()).differences.length > 0);
    }
    const plan = await (await operation(schema, selection)).json();
    await insert({ source: scope.source });
    assert.equal(
      (await operation(schema, selection, { digest: plan.digest, go: true })).status,
      409,
    );
    assert.equal((await db.query("SELECT * FROM basalt_model_import_completion")).rows.length, 0);
  });
});

test("v8 creates only its checkpoint and never skips a later registered v7 migration", async () => {
  await seriesFixture(async ({ db, schema, insert }) => {
    await insert();
    const before = (
      await db.query("SELECT row_to_json(r)::text AS row FROM basalt_model_requests r ORDER BY id")
    ).rows;
    await homeMetadataFixture(db);
    await db.query("DROP TABLE basalt_model_import_completion");
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyImportCompletionVersion,
    ]);
    const v8Plan = await modelHistorySchemaPlan(db);
    assert.deepEqual(v8Plan.pendingMigrations, [historyImportCompletionVersion]);
    assert.deepEqual(v8Plan.catalogDiff.createTables, ["basalt_model_import_completion"]);
    assert.deepEqual(v8Plan.catalogDiff.addIndexes, []);
    assert.deepEqual(v8Plan.catalogDiff.addColumns, []);
    await migrateModelHistory(db);
    const marker = (
      await db.query(
        "SELECT completed_at::text AS at FROM basalt_model_history_migrations WHERE name=$1",
        [historyImportCompletionVersion],
      )
    ).rows;
    const v7 = {
      name: "model_request_history_v7_fixture",
      statements: ["CREATE TABLE fixture_v7_marker (id integer PRIMARY KEY)"],
    };
    const index = historySchemaMigrations.findIndex(
      (m) => m.name === historyImportCompletionVersion,
    );
    historySchemaMigrations.splice(index, 0, v7);
    const directory = await mkdtemp(join(tmpdir(), "history-v7-after-v8-"));
    try {
      const options = historyOperatorOptions([
        "--worker",
        "fixture-pool",
        "--plan",
        join(directory, "plan.json"),
      ]);
      const connect = async () => ({
        env: {
          POOL_OPERATIONS: {
            fetch: (request: Request) => handleModelHistoryOperation(request, connection(schema)),
          },
        },
        dispose: async () => {},
      });
      const preview = await runHistoryOperator(options, "f".repeat(32), connect);
      assert.deepEqual(preview.pendingDdl, v7.statements);
      assert.deepEqual(preview.migrationMarkers, [
        {
          text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)",
          values: [v7.name],
        },
      ]);
      await runHistoryOperator({ ...options, apply: true }, "f".repeat(32), connect);
      await migrateModelHistory(db);
      assert.equal(
        (await db.query("SELECT to_regclass('fixture_v7_marker') AS name")).rows[0]!.name,
        "fixture_v7_marker",
      );
      assert.deepEqual(
        (
          await db.query(
            "SELECT completed_at::text AS at FROM basalt_model_history_migrations WHERE name=$1",
            [historyImportCompletionVersion],
          )
        ).rows,
        marker,
      );
      assert.deepEqual(
        (
          await db.query(
            "SELECT row_to_json(r)::text AS row FROM basalt_model_requests r ORDER BY id",
          )
        ).rows,
        before,
      );
    } finally {
      historySchemaMigrations.splice(index, 1);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
