import { historyJournalPrepareVersion } from "./change-journal-schema.ts";
import { historyImportCompletionPath } from "./import-completion-contract.ts";
import { handleImportCompletion } from "./import-completion.ts";
import { digest } from "../backend-users.ts";
import { activateHomeBackfill, planHomeBackfill, type BackfillPlan } from "./activation.ts";
import { withHistoryDatabase } from "./database.ts";
import { historyApplyFailure } from "./operator-failure.ts";
import {
  counter,
  historyObject,
  HistoryInputError,
  identifier,
  invalidHistory,
  timestamp,
} from "./record.ts";
import { handleTrafficOperation, historyTrafficPath } from "./traffic.ts";
import { handleUsageRollupOperation, historyUsageRollupPath } from "./usage-rollup-backfill.ts";
import {
  activateModelHistoryJournal,
  historyJournalActivationMigration,
  historySchemaMigrations,
  historyAppSchemaVersion,
  historySchemaVersion,
  planModelHistorySchema,
  type HistoryDatabase,
} from "./schema.ts";

// Schema steps are applied only by the release's database step; this boundary plans them.
export const historySchemaCatalogPath = "/model-history/schema/catalog";
export const historyBackfillPath = "/model-history/backfill";
export const historyJournalActivationPath = "/model-history/journal-activation";
export const historyJournalReaderVersion = "checkpoint-count-v1";
export const historyJournalActivationManifest = {
  migration: historyJournalActivationMigration,
  readersReady: historyJournalReaderVersion,
};

export const historyBackfillVersion = "model_request_backfill_v1";

/** Only the named private operator entrypoint calls this service. It never returns usage records. */
export async function modelHistorySchemaPlan(
  db: HistoryDatabase,
  operation: "schema" | "journal-activation" = "schema",
) {
  const activation = operation === "journal-activation";
  const migrations = activation ? [historyJournalActivationMigration] : historySchemaMigrations;
  const catalog = await planModelHistorySchema(db);
  const history = await planHomeBackfill(db);
  const existingTables = new Set(
    catalog.relations
      .filter((row) => row.kind === "r" || row.kind === "p")
      .map((row) => String(row.name)),
  );
  const existingIndexes = new Set(
    catalog.relations
      .filter((row) => row.kind === "i" || row.kind === "I")
      .map((row) => String(row.name)),
  );
  await db.query("BEGIN TRANSACTION READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '3s'");
    const markers = existingTables.has("basalt_model_history_migrations")
      ? new Set(
          (
            await db.query(
              "SELECT name FROM basalt_model_history_migrations WHERE name=ANY($1::text[])",
              [[...migrations.map((migration) => migration.name), historyJournalPrepareVersion]],
            )
          ).rows.map((row) => String(row.name)),
        )
      : new Set<string>();
    const pending = migrations.filter((migration) => !markers.has(migration.name));
    const applied = pending.length === 0;
    const appApplied = markers.has(historyAppSchemaVersion);
    const neededTables = [
      { name: "basalt_model_history_migrations", ifNotExists: true },
      ...pending.flatMap((migration) =>
        migration.statements.flatMap((sql) => {
          const table = /^CREATE TABLE (IF NOT EXISTS )?([a-z0-9_]+)/.exec(sql);
          return table ? [{ name: table[2]!, ifNotExists: Boolean(table[1]) }] : [];
        }),
      ),
    ].sort((a, b) => a.name.localeCompare(b.name));
    const neededIndexes = pending.flatMap((migration) =>
      migration.statements.flatMap((sql) => {
        const name = /^CREATE INDEX ([a-z0-9_]+)/.exec(sql)?.[1];
        return name ? [name] : [];
      }),
    );
    const ledgerRows = existingTables.has("basalt_model_requests")
      ? String(
          (await db.query("SELECT count(*)::text AS rows FROM basalt_model_requests")).rows[0]!
            .rows,
        )
      : "0";
    await db.query("COMMIT");
    const selectedCatalog = activation
      ? {
          ...catalog,
          journalPrepared: markers.has(historyJournalPrepareVersion),
          journalActivated: applied,
          readersReadyRequired: historyJournalReaderVersion,
        }
      : catalog;
    return {
      version: activation ? historyJournalActivationMigration.name : historySchemaVersion,
      schemaHash: await digest(
        JSON.stringify(activation ? historyJournalActivationManifest : migrations),
      ),
      catalogHash: await digest(JSON.stringify(selectedCatalog)),
      catalog: selectedCatalog,
      ...(activation
        ? {
            readersReadyRequired: historyJournalReaderVersion,
            readerInventory:
              "Verify every deployed reader uses checkpoint-count-v1 before activation. This plan does not inspect deployed readers.",
          }
        : {}),
      history,
      ledgerRows,
      applied,
      catalogDiff: {
        createTables: neededTables
          .filter((table) => !existingTables.has(table.name))
          .map((table) => table.name),
        addColumns:
          activation || appApplied
            ? []
            : ["basalt_model_requests.app_id", "basalt_model_requests.requirement"],
        addIndexes: neededIndexes.filter((name) => !existingIndexes.has(name)),
        conflicts: [
          ...(activation && !markers.has(historyJournalPrepareVersion)
            ? [`Requires ${historyJournalPrepareVersion} before activation`]
            : []),
          ...neededTables
            .filter((table) => existingTables.has(table.name) && !table.ifNotExists)
            .map((table) => table.name),
          ...neededIndexes.filter((name) => existingIndexes.has(name)),
        ],
      },
      pendingMigrations: pending.map((migration) => migration.name),
      lockTimeout: "500ms",
      statementTimeout: "5s",
      indexBuild: "transactional, write-blocking, bounded by the timeouts",
      additive: !activation,
      writes: false,
      automaticBackfill: false,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

function approvedBackfill(raw: unknown): BackfillPlan {
  const value = historyObject(raw);
  const source = identifier(value.source, true)!;
  const upperId = counter(value.upperId),
    rows = counter(value.rows);
  if (upperId === null || rows === null || value.privacyReady !== true) return invalidHistory();
  const date = (at: unknown) => {
    if (at === null) return null;
    timestamp(at);
    return String(at);
  };
  return {
    privacyReady: true,
    source,
    upperId,
    rows,
    firstAt: date(value.firstAt),
    lastAt: date(value.lastAt),
  };
}

async function handleBackfillOperation(request: Request, db: HistoryDatabase) {
  if (request.method === "GET") {
    const plan = await planHomeBackfill(db);
    return Response.json(
      {
        status: "dry-run",
        version: historyBackfillVersion,
        plan,
        digest: await digest(JSON.stringify(plan)),
        writes: false,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const approval = historyObject(await request.json());
  if (approval.go !== true) return new Response(null, { status: 400 });
  const plan = approvedBackfill(approval.plan);
  if (approval.digest !== (await digest(JSON.stringify(plan))))
    return new Response(null, { status: 409 });
  await activateHomeBackfill(db, plan);
  return Response.json(
    {
      status: "complete",
      version: historyBackfillVersion,
      digest: approval.digest,
      activated: true,
      through: plan.upperId,
      rows: plan.rows,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleModelHistoryOperation(
  request: Request,
  connectionString: string | undefined,
  /** The pool's own usage rollup backfill, shown beside the usage rollup's dry run. */
  usageRollupAutomatic?: () => Promise<unknown>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const read = path === historySchemaCatalogPath && request.method === "GET";
  const activation = path === historyJournalActivationPath;
  const apply = activation && request.method === "POST";
  const backfill = path === historyBackfillPath;
  const traffic = path === historyTrafficPath;
  const completion = path === historyImportCompletionPath;
  const rollup = path === historyUsageRollupPath;
  if (activation && request.method !== "GET" && request.method !== "POST")
    return new Response(null, { status: 405 });
  if (!read && !apply && !backfill && !traffic && !completion && !activation && !rollup)
    return new Response(null, { status: 404 });
  try {
    if (rollup)
      return await withHistoryDatabase(
        connectionString,
        (db) => handleUsageRollupOperation(request, db, usageRollupAutomatic),
        { totalTimeoutMs: 20_000 },
      );
    if (completion)
      return await withHistoryDatabase(connectionString, (db) =>
        handleImportCompletion(request, db),
      );
    if (traffic)
      return await withHistoryDatabase(connectionString, (db) =>
        handleTrafficOperation(request, db),
      );
    if (backfill)
      return await withHistoryDatabase(connectionString, (db) =>
        handleBackfillOperation(request, db),
      );
    const approval = apply ? historyObject(await request.json()) : undefined;
    if (
      approval &&
      (approval.go !== true ||
        typeof approval.schemaHash !== "string" ||
        typeof approval.catalogHash !== "string" ||
        approval.readersReady !== historyJournalReaderVersion)
    )
      return new Response(null, { status: 400 });
    return await withHistoryDatabase(connectionString, async (db) => {
      const plan = await modelHistorySchemaPlan(db, activation ? "journal-activation" : "schema");
      if (!approval)
        return Response.json(
          { status: "dry-run", ...plan },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (
        approval.schemaHash !== plan.schemaHash ||
        approval.catalogHash !== plan.catalogHash ||
        plan.catalogDiff.conflicts.length
      )
        return new Response(null, { status: 409 });
      await activateModelHistoryJournal(db);
      return Response.json(
        {
          status: "complete",
          version: plan.version,
          schemaHash: plan.schemaHash,
          applied: !plan.applied,
          readersReady: historyJournalReaderVersion,
          automaticBackfill: false,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (error) {
    if (apply && !(error instanceof HistoryInputError) && !(error instanceof SyntaxError))
      console.error("Model history journal activation failed", historyApplyFailure(error));
    return new Response(null, {
      status: error instanceof HistoryInputError || error instanceof SyntaxError ? 400 : 503,
    });
  }
}
