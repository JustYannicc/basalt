import {
  historyImportCompletionVersion,
  historyImportCompletionStatements,
} from "./import-completion-schema.ts";
import { poolDatabase } from "../database-settings.ts";
import { historyBulkSchemaVersion, historyBulkStatements } from "./bulk-schema.ts";

export interface HistoryDatabase {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export const historyBaseSchemaVersion = "model_request_history_v1";
export const historyAppSchemaVersion = "model_request_history_v2_app_attribution";
export const historyAccountTimeSchemaVersion = "model_request_history_v3_account_time";
export const historyTrafficSchemaVersion = "model_request_history_v4_traffic_purpose";
export const historySchemaVersion = historyImportCompletionVersion;

/** Catalog-only preview. The same query works before any history table exists. */
export async function planModelHistorySchema(db: HistoryDatabase) {
  await db.query("BEGIN TRANSACTION READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '3s'");
    const identity = await db.query(
      "SELECT current_database() AS database, current_user AS role, current_schema() AS schema",
    );
    const relations = await db.query(`SELECT c.relname AS name,c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname LIKE 'basalt_model_%' ORDER BY c.relname`);
    await db.query("COMMIT");
    return { identity: identity.rows[0], relations: relations.rows, writes: false };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// Hash partitions keep the unique request identity on the table itself. No second receipt
// per request, no default partition to drain, and no time partition that a retention job can drop.
export const historySchemaStatements = [
  `CREATE TABLE basalt_model_requests (
    id char(64) PRIMARY KEY,
    source char(64) NOT NULL,
    source_record char(64) NOT NULL,
    timestamp timestamptz NOT NULL,
    timestamp_exact varchar(30) NOT NULL,
    pool varchar(16), person char(64), account char(64), client_key char(64),
    request_id varchar(256), provider varchar(256), model varchar(256),
    endpoint varchar(256), api_type varchar(64), service_tier varchar(256),
    input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
    reasoning_tokens bigint, total_tokens bigint, latency_ms bigint,
    token_quality varchar(16) NOT NULL,
    failed boolean NOT NULL, status_code smallint,
    cost numeric(28,12), currency varchar(16), cost_basis varchar(32) NOT NULL,
    price_version char(64), original_price_rule varchar(1024), price_snapshot jsonb, attribution varchar(32) NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (token_quality IN ('complete','legacy','unclassified','inconsistent')),
    CHECK (cost_basis IN ('home-charge','historical-api-price','unpriced')),
    CHECK (attribution IN ('charge-snapshot','key-at-capture','import-owner','unknown')),
    CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
    CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0
      AND cache_write_tokens >= 0 AND reasoning_tokens >= 0 AND total_tokens >= 0 AND latency_ms >= 0),
    CHECK (cost >= 0),
    CHECK ((cost_basis = 'unpriced' AND cost IS NULL AND currency IS NULL)
      OR (cost_basis <> 'unpriced' AND cost IS NOT NULL AND currency IS NOT NULL)),
    CHECK (price_snapshot IS NULL OR price_version IS NOT NULL),
    CHECK (id ~ '^[0-9a-f]{64}$' AND source ~ '^[0-9a-f]{64}$' AND source_record ~ '^[0-9a-f]{64}$')
  ) PARTITION BY HASH (id)`,
  ...Array.from(
    { length: 16 },
    (_, remainder) => `CREATE TABLE basalt_model_requests_${remainder}
    PARTITION OF basalt_model_requests FOR VALUES WITH (MODULUS 16, REMAINDER ${remainder})`,
  ),
  `CREATE INDEX basalt_model_requests_pool_time ON basalt_model_requests (pool, timestamp, id)`,
  `CREATE INDEX basalt_model_requests_person_time ON basalt_model_requests (pool, person, timestamp, id)`,
  `CREATE INDEX basalt_model_requests_source_record ON basalt_model_requests (source, source_record)`,
  `CREATE TABLE basalt_model_history_cursor (
    source char(64) PRIMARY KEY,
    forward_id bigint NOT NULL,
    backfill_upper bigint NOT NULL,
    backfill_id bigint NOT NULL,
    backfill_complete boolean NOT NULL DEFAULT false,
    sweep_id bigint NOT NULL,
    sweep_upper bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  // Reject ordinary UPDATE/DELETE/TRUNCATE, including accidental cleanup through a parent table.
  // The schema owner remains responsible for deliberate DDL and disaster recovery.
  `CREATE FUNCTION basalt_model_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Model request history is append only' USING ERRCODE = '55000'; END
  $$`,
  `CREATE TRIGGER basalt_model_history_no_rewrite BEFORE UPDATE OR DELETE ON basalt_model_requests
    FOR EACH ROW EXECUTE FUNCTION basalt_model_history_append_only()`,
  `CREATE TRIGGER basalt_model_history_no_truncate BEFORE TRUNCATE ON basalt_model_requests
    FOR EACH STATEMENT EXECUTE FUNCTION basalt_model_history_append_only()`,
  ...Array.from(
    { length: 16 },
    (_, part) => `CREATE TRIGGER basalt_model_history_no_truncate
    BEFORE TRUNCATE ON basalt_model_requests_${part}
    FOR EACH STATEMENT EXECUTE FUNCTION basalt_model_history_append_only()`,
  ),
];

export const historyAppAttributionStatements = [
  "ALTER TABLE basalt_model_requests ADD COLUMN app_id varchar(256), ADD COLUMN requirement varchar(64)",
];
export const historyAccountTimeStatements = [
  "CREATE INDEX basalt_model_requests_account_time ON basalt_model_requests (pool, account, timestamp)",
];
export const historyTrafficStatements = [
  `CREATE TABLE basalt_model_traffic (
    pool varchar(16) NOT NULL, source char(64) NOT NULL, client_key char(64) NOT NULL,
    purpose varchar(8) NOT NULL CHECK (purpose IN ('real','proof')),
    evidence char(64) NOT NULL, changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pool,source,client_key),
    CHECK (pool ~ '^[a-f0-9]{16}$' AND source ~ '^[a-f0-9]{64}$'
      AND client_key ~ '^[a-f0-9]{64}$' AND evidence ~ '^[a-f0-9]{64}$')
  )`,
];
export const historySchemaMigrations = [
  { name: historyBaseSchemaVersion, statements: historySchemaStatements },
  { name: historyAppSchemaVersion, statements: historyAppAttributionStatements },
  { name: historyAccountTimeSchemaVersion, statements: historyAccountTimeStatements },
  { name: historyTrafficSchemaVersion, statements: historyTrafficStatements },
  { name: historyBulkSchemaVersion, statements: historyBulkStatements },
  { name: historyImportCompletionVersion, statements: historyImportCompletionStatements },
];
/** Existing collectors keep working while the additive app migration awaits its approved apply. */
export async function appAttributionReady(db: HistoryDatabase): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM basalt_model_history_migrations WHERE name = $1", [
    historyAppSchemaVersion,
  ]);
  return result.rows.length === 1;
}

/** Additive, separate from Home's numbered migrations. Never reads or copies historical payloads. */
export async function migrateModelHistory(db: HistoryDatabase): Promise<void> {
  await db.query("BEGIN");
  try {
    await db.query(`SET LOCAL ROLE "${poolDatabase.owner}"`);
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    await db.query("SELECT pg_advisory_xact_lock(1409, 20)");
    await db.query(`CREATE TABLE IF NOT EXISTS basalt_model_history_migrations (
      name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    for (const migration of historySchemaMigrations) {
      const applied = await db.query(
        "SELECT 1 FROM basalt_model_history_migrations WHERE name = $1",
        [migration.name],
      );
      if (!applied.rows.length) {
        for (const sql of migration.statements) await db.query(sql);
        await db.query("INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", [
          migration.name,
        ]);
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
