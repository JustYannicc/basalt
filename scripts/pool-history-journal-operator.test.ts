import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { historyOperatorOptions, runHistoryOperator } from "./pool-history-operator.ts";
import {
  handleModelHistoryOperation,
  historyJournalActivationManifest,
  historyJournalActivationPath,
  historyJournalReaderVersion,
  modelHistorySchemaPlan,
} from "../src/pool/model-history/operator.ts";
import {
  activateModelHistoryJournal,
  historyJournalActivationMigration,
  migrateModelHistory,
  type HistoryDatabase,
} from "../src/pool/model-history/schema.ts";
import { historyJournalPrepareVersion } from "../src/pool/model-history/change-journal-schema.ts";
import { historyMemoryOwnerFixture, homeMetadataFixture } from "./pool-tests/history-fixture.ts";

const account = "a".repeat(32);

test("journal activation requires the exact reader acknowledgement on apply only", async () => {
  const args = [
    "--worker",
    "fixture-pool",
    "--plan",
    "private.json",
    "--operation",
    "journal-activation",
  ];
  assert.equal(historyOperatorOptions(args).operation, "journal-activation");
  for (const acknowledgement of [[], ["--readers-ready", "legacy-count-v1"]])
    assert.throws(() => historyOperatorOptions([...args, "--apply", "--go", ...acknowledgement]));
  assert.equal(
    historyOperatorOptions([
      ...args,
      "--apply",
      "--go",
      "--readers-ready",
      historyJournalReaderVersion,
    ]).readersReady,
    historyJournalReaderVersion,
  );
  for (const readersReady of [undefined, "legacy-count-v1"])
    assert.equal(
      (
        await handleModelHistoryOperation(
          new Request("http://private" + historyJournalActivationPath, {
            method: "POST",
            body: JSON.stringify({
              go: true,
              schemaHash: "a".repeat(64),
              catalogHash: "b".repeat(64),
              readersReady,
            }),
          }),
          undefined,
        )
      ).status,
      400,
    );
});

test("activation plans select only v10 despite higher unrelated markers and preserve default preparation", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "history-journal-operator-"));
  try {
    await historyMemoryOwnerFixture(db);
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    await db.query("INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", [
      "model_request_history_v999_unrelated",
    ]);
    const normal = await modelHistorySchemaPlan(db);
    assert.equal(normal.version, historyJournalPrepareVersion);
    assert.equal(normal.applied, true);
    assert.equal(
      (
        await db.query("SELECT 1 FROM basalt_model_history_migrations WHERE name=$1", [
          historyJournalActivationMigration.name,
        ])
      ).rows.length,
      0,
    );
    const activation = await modelHistorySchemaPlan(db, "journal-activation");
    assert.deepEqual(activation.pendingMigrations, [historyJournalActivationMigration.name]);
    assert.equal(activation.readersReadyRequired, historyJournalReaderVersion);
    assert.match(activation.readerInventory!, /does not inspect deployed readers/);
    assert.equal(
      activation.schemaHash,
      createHash("sha256").update(JSON.stringify(historyJournalActivationManifest)).digest("hex"),
    );
    assert.equal(activation.additive, false);

    const path = join(directory, "plan.json");
    const args = ["--worker", "fixture-pool", "--plan", path, "--operation", "journal-activation"];
    let writes = 0;
    const connect = async () => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            assert.equal(new URL(request.url).pathname, historyJournalActivationPath);
            const plan = await modelHistorySchemaPlan(db, "journal-activation");
            if (request.method === "GET") return Response.json({ status: "dry-run", ...plan });
            writes++;
            assert.deepEqual(await request.json(), {
              schemaHash: plan.schemaHash,
              catalogHash: plan.catalogHash,
              readersReady: historyJournalReaderVersion,
              go: true,
            });
            await activateModelHistoryJournal(db);
            return Response.json({
              status: "complete",
              version: plan.version,
              schemaHash: plan.schemaHash,
              applied: true,
              readersReady: historyJournalReaderVersion,
            });
          },
        },
      },
      dispose: async () => {},
    });
    const preview = await runHistoryOperator(historyOperatorOptions(args), account, connect);
    assert.deepEqual(preview.pendingDdl, historyJournalActivationMigration.statements);
    assert.deepEqual(preview.migrationMarkers, [
      {
        text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)",
        values: [historyJournalActivationMigration.name],
      },
    ]);
    const applying = historyOperatorOptions([
      ...args,
      "--apply",
      "--go",
      "--readers-ready",
      historyJournalReaderVersion,
    ]);
    await assert.rejects(
      runHistoryOperator({ ...applying, readersReady: undefined }, account, connect),
      /reader inventory/,
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    for (const change of [
      { readersReadyRequired: "legacy-count-v1" },
      { version: historyJournalPrepareVersion },
      { pendingDdl: [] },
    ]) {
      await writeFile(path, JSON.stringify({ ...saved, report: { ...saved.report, ...change } }));
      await assert.rejects(
        runHistoryOperator(applying, account, async () => {
          throw new Error("must reject before connecting");
        }),
        /reader contract changed|statements changed/,
      );
    }
    await writeFile(path, JSON.stringify(saved));
    await runHistoryOperator(applying, account, connect);
    assert.equal(writes, 1);
    assert.equal((await modelHistorySchemaPlan(db, "journal-activation")).applied, true);
    assert.equal((await modelHistorySchemaPlan(db)).version, historyJournalPrepareVersion);
    await assert.rejects(runHistoryOperator(applying, account, connect));
    assert.equal(writes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await database.close();
  }
});

test("activation dry run reports a missing exact prepare marker as a conflict", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    await historyMemoryOwnerFixture(db);
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyJournalPrepareVersion,
    ]);
    const plan = await modelHistorySchemaPlan(db, "journal-activation");
    assert.deepEqual(plan.catalogDiff.conflicts, [
      "Requires " + historyJournalPrepareVersion + " before activation",
    ]);
    await assert.rejects(activateModelHistoryJournal(db), /before activation/);
    assert.equal(
      (
        await db.query("SELECT 1 FROM basalt_model_history_migrations WHERE name=$1", [
          historyJournalActivationMigration.name,
        ])
      ).rows.length,
      0,
    );
  } finally {
    await database.close();
  }
});
