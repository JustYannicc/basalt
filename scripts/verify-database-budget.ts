import pg from "pg";
import {
  backendCountSql,
  retirement,
  verifyDatabaseBudget,
  type BackendCount,
} from "./database-budget-verification.ts";
import { postgresRoleName } from "../src/pool/database-settings.ts";

export async function checkDatabaseBackends(options: {
  adminUrl: string;
  runtimeLogins: string[];
  databases: string[];
  deadlineMs?: number;
}) {
  const client = new pg.Client({
    connectionString: options.adminUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  client.on("error", () => {});
  const deadlineMs = options.deadlineMs ?? retirement.verificationMs;
  const abort = new AbortController();
  const hardDeadline = setTimeout(() => {
    // A half-open monitoring connection must not leave deployment waiting forever.
    abort.abort(new Error("Database backend verification deadline exceeded"));
    client.connection.stream.destroy();
  }, deadlineMs);
  try {
    await client.connect();
    const counts = await verifyDatabaseBudget({
      databases: options.databases,
      deadlineMs,
      signal: abort.signal,
      read: async () => {
        await client.query("BEGIN TRANSACTION READ ONLY");
        try {
          await client.query("SET LOCAL statement_timeout = '4s'");
          const result = await client.query<BackendCount>(backendCountSql, [
            options.runtimeLogins.map(postgresRoleName),
          ]);
          await client.query("COMMIT");
          return result.rows;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      },
    });
    console.log(JSON.stringify({ databaseBackendBudget: 5, converged: true, counts }));
    return counts;
  } catch {
    // Driver errors can contain endpoint/user information. This is a failed acceptance step.
    throw new Error(
      `Database runtime backends did not converge to five per logical database within ${deadlineMs}ms`,
    );
  } finally {
    clearTimeout(hardDeadline);
    client.connection.stream.destroy();
    await client.end();
  }
}

function list(value: string | undefined) {
  const parsed: unknown = JSON.parse(value ?? "null");
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((entry) => typeof entry !== "string" || !entry)
  )
    throw new Error("Database budget verification requires explicit runtime logins and databases");
  return parsed as string[];
}

if (import.meta.main)
  await checkDatabaseBackends({
    adminUrl: process.env.DATABASE_BUDGET_ADMIN_URL ?? "",
    runtimeLogins: list(process.env.DATABASE_BUDGET_RUNTIME_LOGINS),
    databases: list(process.env.DATABASE_BUDGET_DATABASES),
  });
