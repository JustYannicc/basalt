import { digest } from "../backend-users.ts";
import { activateHomeBackfill, planHomeBackfill, type BackfillPlan } from "./activation.ts";
import { withHistoryDatabase } from "./database.ts";
import {
  counter,
  historyObject,
  HistoryInputError,
  identifier,
  invalidHistory,
  timestamp,
} from "./record.ts";
import { handleTrafficOperation, historyTrafficPath } from "./traffic.ts";
import {
  historySchemaMigrations,
  historyAppSchemaVersion,
  historySchemaVersion,
  migrateModelHistory,
  planModelHistorySchema,
  type HistoryDatabase,
} from "./schema.ts";

export const historySchemaCatalogPath = "/model-history/schema/catalog";
export const historySchemaApplyPath = "/model-history/schema";
export const historyBackfillPath = "/model-history/backfill";
export const historyBackfillVersion = "model_request_backfill_v1";

/** Only the named private operator entrypoint calls this service. It never returns usage records. */
export async function modelHistorySchemaPlan(db: HistoryDatabase) {
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
              [historySchemaMigrations.map((migration) => migration.name)],
            )
          ).rows.map((row) => String(row.name)),
        )
      : new Set<string>();
    const pending = historySchemaMigrations.filter((migration) => !markers.has(migration.name));
    const applied = pending.length === 0;
    const neededTables = [
      ...(existingTables.has("basalt_model_history_migrations")
        ? []
        : ["basalt_model_history_migrations"]),
      ...pending.flatMap((migration) =>
        migration.statements.flatMap((sql) => {
          const name = /^CREATE TABLE ([a-z0-9_]+)/.exec(sql)?.[1];
          return name ? [name] : [];
        }),
      ),
    ];
    const neededIndexes = pending.flatMap((migration) =>
      migration.statements.flatMap((sql) => {
        const name = /^CREATE INDEX ([a-z0-9_]+)/.exec(sql)?.[1];
        return name ? [name] : [];
      }),
    );
    const appApplied = markers.has(historyAppSchemaVersion);
    const ledgerRows = existingTables.has("basalt_model_requests")
      ? String(
          (await db.query("SELECT count(*)::text AS rows FROM basalt_model_requests")).rows[0]!
            .rows,
        )
      : "0";
    await db.query("COMMIT");
    return {
      version: historySchemaVersion,
      schemaHash: await digest(JSON.stringify(historySchemaMigrations)),
      catalogHash: await digest(JSON.stringify(catalog)),
      catalog,
      history,
      ledgerRows,
      applied,
      catalogDiff: {
        createTables: neededTables.filter((name) => !existingTables.has(name)),
        addColumns: appApplied
          ? []
          : ["basalt_model_requests.app_id", "basalt_model_requests.requirement"],
        addIndexes: neededIndexes.filter((name) => !existingIndexes.has(name)),
        conflicts: [
          ...neededTables.filter(
            (name) => existingTables.has(name) && name !== "basalt_model_history_migrations",
          ),
          ...neededIndexes.filter((name) => existingIndexes.has(name)),
        ],
      },
      pendingMigrations: historySchemaMigrations
        .filter((migration) => !markers.has(migration.name))
        .map((migration) => migration.name),
      lockTimeout: "500ms",
      statementTimeout: "5s",
      indexBuild: "transactional, write-blocking, bounded by the timeouts",
      additive: true,
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
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const read = path === historySchemaCatalogPath && request.method === "GET";
  const apply = path === historySchemaApplyPath && request.method === "POST";
  const backfill = path === historyBackfillPath;
  const traffic = path === historyTrafficPath;
  if (!read && !apply && !backfill && !traffic) return new Response(null, { status: 404 });
  try {
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
        typeof approval.catalogHash !== "string")
    )
      return new Response(null, { status: 400 });
    return await withHistoryDatabase(connectionString, async (db) => {
      const plan = await modelHistorySchemaPlan(db);
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
      await migrateModelHistory(db);
      return Response.json(
        {
          status: "complete",
          version: plan.version,
          schemaHash: plan.schemaHash,
          applied: !plan.applied,
          automaticBackfill: false,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (error) {
    return new Response(null, {
      status: error instanceof HistoryInputError || error instanceof SyntaxError ? 400 : 503,
    });
  }
}
