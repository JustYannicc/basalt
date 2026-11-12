import {
  observeSqlVersions,
  unreadableSqlSchema,
  validateSqlExpectations,
  type SqlDatabase,
  type SqlSchemaExpectation,
  type SqlSchemaObservation,
  type SqlSchemaReceipt,
} from "./sql-schema-contract.ts";

export interface SqlJournalSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
export interface SqlJournalSource {
  databaseName: string;
  connect(): Promise<SqlJournalSession>;
}

const queries: Record<SqlSchemaExpectation["namespace"], string> = {
  hosted:
    "SELECT migration_id, name FROM public.private_hosted_migrations ORDER BY migration_id LIMIT 257",
  cloud:
    "SELECT migration_id, name FROM public.private_cloud_migrations ORDER BY migration_id LIMIT 257",
  sdk: "SELECT value FROM public.private_executor_settings WHERE key = 'version' LIMIT 2",
  registry:
    "SELECT value FROM public.private_executor_public_apps_settings WHERE key = 'version' LIMIT 2",
  "model-history":
    "SELECT name FROM public.basalt_model_history_migrations ORDER BY name LIMIT 257",
  home: "SELECT id, version FROM public.home_schema_migration ORDER BY id LIMIT 2",
};

function versions(expectation: SqlSchemaExpectation, rows: Record<string, unknown>[]): string[] {
  if (rows.length > 256) throw new Error("marker-count");
  return rows.map((row) => {
    if (expectation.namespace === "hosted" || expectation.namespace === "cloud") {
      if (
        !Number.isSafeInteger(row.migration_id) ||
        Number(row.migration_id) <= 0 ||
        typeof row.name !== "string"
      )
        throw new Error("marker");
      return `${row.migration_id}_${row.name}`;
    }
    if (expectation.namespace === "model-history") {
      if (typeof row.name !== "string") throw new Error("marker");
      return row.name;
    }
    if (expectation.namespace === "home") {
      if (
        String(row.id) !== "1" ||
        !/^\d+$/.test(String(row.version)) ||
        !Number.isSafeInteger(Number(row.version))
      )
        throw new Error("marker");
      return String(row.version);
    }
    if (typeof row.value !== "string") throw new Error("marker");
    return row.value;
  });
}

async function readDatabase(
  source: SqlJournalSource,
  expectations: SqlSchemaExpectation[],
): Promise<SqlSchemaObservation[]> {
  let session: SqlJournalSession;
  try {
    session = await source.connect();
  } catch (error) {
    return expectations.map((entry) => unreadableSqlSchema(entry, "connection", error));
  }
  const observations: SqlSchemaObservation[] = [];
  try {
    await session.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await session.query("SET LOCAL lock_timeout = '500ms'");
    await session.query("SET LOCAL statement_timeout = '3s'");
    const identity = await session.query(
      `SELECT current_database() = $1 AS database_matches,
      current_schema() = 'public' AS schema_matches,
      current_setting('transaction_read_only') = 'on' AS read_only`,
      [source.databaseName],
    );
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]!.database_matches !== true ||
      identity.rows[0]!.schema_matches !== true ||
      identity.rows[0]!.read_only !== true
    )
      return expectations.map((entry) => unreadableSqlSchema(entry, "identity"));
    const catalog = await session.query(
      `SELECT c.relname AS name,c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
      [expectations.map((entry) => entry.journal)],
    );
    for (const expectation of expectations) {
      const matches = catalog.rows.filter((row) => row.name === expectation.journal);
      if (matches.length !== 1 || matches[0]!.kind !== "r") {
        observations.push(
          unreadableSqlSchema(expectation, matches.length ? "journal-type" : "journal-missing"),
        );
        continue;
      }
      // One denied journal must not abort the read transaction and hide the other namespace receipts.
      await session.query("SAVEPOINT schema_observation");
      try {
        const rows = await session.query(queries[expectation.namespace]);
        let applied: string[];
        try {
          applied = versions(expectation, rows.rows);
        } catch {
          observations.push(unreadableSqlSchema(expectation, "invalid-marker"));
          continue;
        }
        observations.push(observeSqlVersions(expectation, applied));
      } catch (error) {
        await session.query("ROLLBACK TO SAVEPOINT schema_observation").catch(() => {});
        observations.push(unreadableSqlSchema(expectation, "query", error));
      } finally {
        await session.query("RELEASE SAVEPOINT schema_observation");
      }
    }
    await session.query("COMMIT");
    return observations;
  } catch (error) {
    await session.query("ROLLBACK").catch(() => {});
    // A failed snapshot or commit cannot establish any namespace in this database as ready.
    return expectations.map((entry) => unreadableSqlSchema(entry, "query", error));
  } finally {
    await session.query("ROLLBACK").catch(() => {});
    await session.end().catch(() => {});
  }
}

/** Two bounded snapshots, with their own times. This never bootstraps a journal or calls a migrator. */
export async function readSqlSchemas(options: {
  candidate: string;
  homeImageDigest: string;
  expectations: SqlSchemaExpectation[];
  sources: Record<SqlDatabase, SqlJournalSource>;
}): Promise<SqlSchemaReceipt> {
  validateSqlExpectations(options.expectations);
  const observations = [];
  for (const database of ["tools", "pool"] as const) {
    observations.push(
      ...(await readDatabase(
        options.sources[database],
        options.expectations.filter((entry) => entry.database === database),
      )),
    );
  }
  return {
    formatVersion: 1,
    candidate: options.candidate,
    homeImageDigest: options.homeImageDigest,
    scope: "six-schema-namespaces",
    observations,
  };
}
