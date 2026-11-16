import { BarrierRefusal } from "./refusal.ts";
import {
  readSqlSnapshot,
  SqlSnapshotFailure,
  type SqlJournalSource,
  type SqlJournalSession,
} from "./sql-schema-read.ts";

export const authSchemaTables = [
  "user",
  "session",
  "account",
  "verification",
  "rateLimit",
  "apikey",
  "organization",
  "member",
  "invitation",
  "ssoProvider",
  "passkey",
  "mcpGrant",
  "mcpConnection",
  "oauthClient",
  "oauthResource",
  "oauthClientResource",
  "oauthRefreshToken",
  "oauthAccessToken",
  "oauthConsent",
  "oauthClientAssertion",
] as const;
const journals = [
  {
    namespace: "sdk",
    table: "private_executor_settings",
    query:
      "SELECT CASE WHEN octet_length(value) <= 32 THEN value ELSE NULL END AS value FROM public.private_executor_settings WHERE key = 'version' LIMIT 2",
  },
  {
    namespace: "hosted",
    table: "private_hosted_migrations",
    query:
      "SELECT migration_id FROM public.private_hosted_migrations ORDER BY migration_id LIMIT 257",
  },
  {
    namespace: "cloud",
    table: "private_cloud_migrations",
    query:
      "SELECT migration_id FROM public.private_cloud_migrations ORDER BY migration_id LIMIT 257",
  },
] as const;
type Observation = {
  status: "observed" | "missing" | "unreadable";
  reason?: "connection" | "identity" | "query" | "journal-type" | "bounds" | "invalid-marker";
  sqlState?: string;
};
type Journal = Observation & {
  namespace: "sdk" | "hosted" | "cloud";
  versions?: string[];
  migrationIds?: number[];
};
type AuthTable = Observation & { table: string; columns?: string[] };
const sqlState = (error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return /^[A-Z0-9]{5}$/u.test(code) ? { sqlState: code } : {};
};
const unreadable = (reason: Observation["reason"], error?: unknown): Observation => ({
  status: "unreadable",
  reason,
  ...sqlState(error),
});

async function observe<A extends Observation>(
  session: SqlJournalSession,
  read: () => Promise<A>,
): Promise<A | Observation> {
  await session.query("SAVEPOINT schema_inspection");
  try {
    return await read();
  } catch (error) {
    await session.query("ROLLBACK TO SAVEPOINT schema_inspection");
    return unreadable("query", error);
  } finally {
    await session.query("RELEASE SAVEPOINT schema_inspection");
  }
}

/** Closed selections contain SQL in source. Neither callers nor observed rows can choose a query. */
export async function inspectSqlSchema(options: {
  selection: string;
  tooling: string;
  source: SqlJournalSource;
}) {
  if (options.selection !== "schema-v1" || !/^[a-f0-9]{40}$/u.test(options.tooling))
    throw new BarrierRefusal("schema-inspection-input");
  let result: { journals: Journal[]; auth: AuthTable[] };
  try {
    result = await readSqlSnapshot(options.source, async (session) => {
      const names = [...journals.map((v) => v.table), ...authSchemaTables];
      const catalog = await session.query(
        `SELECT c.relname AS name,c.relkind AS kind
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1::text[]) LIMIT 24`,
        [names],
      );
      if (catalog.rows.length > names.length) throw new SqlSnapshotFailure("query");
      const presence = (name: string): Observation | undefined => {
        const matches = catalog.rows.filter((r) => r.name === name);
        if (!matches.length) return { status: "missing" };
        if (matches.length !== 1 || matches[0]!.kind !== "r") return unreadable("journal-type");
        return undefined;
      };
      const journalResults: Journal[] = [];
      for (const entry of journals) {
        const absent = presence(entry.table);
        const observation =
          absent ??
          (await observe(session, async () => {
            const { rows } = await session.query(entry.query);
            if (entry.namespace === "sdk") {
              if (
                rows.length !== 1 ||
                rows.some(
                  (r) =>
                    typeof r.value !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(r.value),
                )
              )
                return unreadable("invalid-marker");
              return { status: "observed" as const, versions: rows.map((r) => String(r.value)) };
            }
            if (rows.length > 256) return unreadable("bounds");
            const ids = rows.map((r) => r.migration_id);
            if (
              ids.some((id) => !Number.isSafeInteger(id) || Number(id) < 1) ||
              new Set(ids).size !== ids.length
            )
              return unreadable("invalid-marker");
            return { status: "observed" as const, migrationIds: ids.map(Number) };
          }));
        journalResults.push({ namespace: entry.namespace, ...observation });
      }
      const columns = await observe(session, async () => {
        const { rows } = await session.query(
          `SELECT c.relname AS table_name,a.attname AS column_name
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind='r'
          AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum LIMIT 513`,
          [[...authSchemaTables]],
        );
        if (
          rows.length > 512 ||
          rows.some(
            (r) =>
              !authSchemaTables.some((t) => t === r.table_name) ||
              typeof r.column_name !== "string" ||
              !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(r.column_name),
          )
        )
          return unreadable("bounds");
        return { status: "observed" as const, rows };
      });
      const auth: AuthTable[] = authSchemaTables.map((table) => {
        const absent = presence(table);
        if (absent) return { table, ...absent };
        if (!("rows" in columns)) return { table, ...columns };
        const names = columns.rows
          .filter((r) => r.table_name === table)
          .map((r) => String(r.column_name));
        return names.length > 64 || !names.length || new Set(names).size !== names.length
          ? { table, ...unreadable("bounds") }
          : { table, status: "observed", columns: names };
      });
      return { journals: journalResults, auth };
    });
  } catch (error) {
    const failure = unreadable(error instanceof SqlSnapshotFailure ? error.reason : "query", error);
    result = {
      journals: journals.map((v) => ({ namespace: v.namespace, ...failure })),
      auth: authSchemaTables.map((table) => ({ table, ...failure })),
    };
  }
  return {
    formatVersion: 1 as const,
    selection: "schema-v1" as const,
    tooling: options.tooling,
    observedAt: new Date().toISOString(),
    status:
      result.journals.some((v) => v.status !== "observed") ||
      result.auth.some((v) => v.status === "unreadable")
        ? ("incomplete" as const)
        : ("complete" as const),
    ...result,
  };
}
