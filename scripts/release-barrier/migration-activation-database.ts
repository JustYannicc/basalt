import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import type { SqlJournalSource } from "./sql-schema-read.ts";

export interface JournalFunction {
  name: string;
  args: string;
  result: string;
  language: string;
  body: string;
  volatility: string;
}
const normalized = (value: string) => value.replace(/\r\n/g, "\n").trim();

/** Function bodies are compared inside a read-only snapshot, never executed as probes. */
export async function readMigrationJournalDatabase(options: {
  source: SqlJournalSource;
  kind: "hosted" | "pool";
  prepared: readonly JournalFunction[];
  active: readonly JournalFunction[];
  inactive: readonly JournalFunction[];
}) {
  const { source, kind } = options;
  const prefix = kind === "hosted" ? "hosted" : "basalt_pool";
  const session = await source.connect().catch(() => {
    throw new BarrierRefusal("migration-activation-sql-connect", kind);
  });
  try {
    await session.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await session.query("SET LOCAL statement_timeout = '3s'");
    await session.query("SET LOCAL lock_timeout = '500ms'");
    const identity = await session.query(
      `SELECT current_database()=$1 AS database_matches,
      current_schema()='public' AS schema_matches,current_setting('transaction_read_only')='on' AS read_only`,
      [source.databaseName],
    );
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]?.database_matches !== true ||
      identity.rows[0]?.schema_matches !== true ||
      identity.rows[0]?.read_only !== true
    )
      throw new Error();
    const markers = await session.query(
      kind === "hosted"
        ? "SELECT migration_id,name FROM public.private_hosted_migrations WHERE migration_id IN (21,22) ORDER BY migration_id"
        : "SELECT name FROM public.basalt_model_history_migrations WHERE name=ANY($1::text[]) ORDER BY name",
      kind === "pool"
        ? [
            [
              "model_request_history_v9_change_journal_prepare",
              "model_request_history_v10_change_journal_activate",
            ],
          ]
        : undefined,
    );
    const functions = await session.query(
      `SELECT p.proname AS name,oidvectortypes(p.proargtypes) AS args,
      pg_get_function_result(p.oid) AS result,l.lanname AS language,p.prosrc AS body,
      p.provolatile AS volatility,p.prosecdef AS security_definer,p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname,p.oid`,
      [
        [
          ...new Set(
            [...options.prepared, ...options.active, ...options.inactive].map((fn) => fn.name),
          ),
        ],
      ],
    );
    const matches = (expected: readonly JournalFunction[]) =>
      expected.every((fn) => {
        const rows = functions.rows.filter((row) => row.name === fn.name);
        const row = rows[0];
        return (
          rows.length === 1 &&
          row !== undefined &&
          row.security_definer === false &&
          row.config === null &&
          Object.entries(fn).every(
            ([key, value]) =>
              typeof row[key] === "string" && normalized(row[key]) === normalized(value),
          )
        );
      });
    const trigger = await session.query(
      `SELECT t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,
      t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,p.proname AS function,
      fn.nspname AS function_schema,t.tgisinternal AS internal,t.tgqual::text AS condition,
      encode(t.tgargs,'hex') AS arguments
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname=$1 AND t.tgname=$2`,
      [`${prefix}_change_batches`, `${prefix}_flush_changes`],
    );
    const has = (id: number, name: string) =>
      markers.rows.some((row) => row.name === name && (kind === "pool" || row.migration_id === id));
    const preparedMarker = has(
      21,
      kind === "hosted"
        ? "change_journal_prepare"
        : "model_request_history_v9_change_journal_prepare",
    );
    const activeMarker = has(
      22,
      kind === "hosted"
        ? "change_journal_activate"
        : "model_request_history_v10_change_journal_activate",
    );
    const row = trigger.rows[0];
    const triggerReady =
      trigger.rows.length === 1 &&
      row?.type === 5 &&
      row.enabled === "O" &&
      row.deferrable === true &&
      row.deferred === true &&
      row.function === `${prefix}_flush_changes` &&
      row.function_schema === "public" &&
      row.internal === false &&
      row.condition === null &&
      row.arguments === "";
    const active =
      preparedMarker &&
      activeMarker &&
      matches(options.prepared) &&
      matches(options.active) &&
      triggerReady;
    const prepared =
      preparedMarker &&
      matches(options.prepared) &&
      (active ||
        (!activeMarker &&
          matches(options.inactive) &&
          (kind === "pool" ? trigger.rows.length === 0 : triggerReady)));
    await session.query("COMMIT");
    return {
      prepared,
      active,
      fingerprint: digest(
        canonical({ markers: markers.rows, functions: functions.rows, trigger: trigger.rows }),
      ),
    };
  } catch {
    await session.query("ROLLBACK").catch(() => {});
    throw new BarrierRefusal("migration-activation-sql-observation", kind);
  } finally {
    await session.end().catch(() => {
      throw new BarrierRefusal("migration-activation-sql-close", kind);
    });
  }
}
