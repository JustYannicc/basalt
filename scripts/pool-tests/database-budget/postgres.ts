import assert from "node:assert/strict";
import pg from "pg";

export function localDatabaseUrl(value: string | undefined) {
  assert.ok(value, "The isolated database URL is required");
  const url = new URL(value);
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname), "The proof must use local fixtures");
  return url;
}

export async function connect(url: string | URL) {
  const client = new pg.Client({
    connectionString: String(url),
    connectionTimeoutMillis: 2_500,
    query_timeout: 6_000,
  });
  client.on("error", () => {});
  await client.connect();
  return client;
}

export function runtimeUrl(base: URL, database: string, role: string) {
  const url = new URL(base);
  url.pathname = "/" + database;
  url.username = role;
  url.password = "fixture-only";
  url.search = "?sslmode=disable";
  return url.toString();
}

export async function runtimeBackends(admin: pg.Client, databases: string[]) {
  const result = await admin.query<{ connections: number }>(
    "SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND usename=ANY($2::text[])",
    [databases, ["budget_a", "budget_b"]],
  );
  return result.rows[0]!.connections;
}

export async function waitForBackendCount(admin: pg.Client, databases: string[], expected: number) {
  const deadline = performance.now() + 2_000;
  let count = 0;
  while (performance.now() < deadline) {
    count = await runtimeBackends(admin, databases);
    if (count >= expected) return count;
  }
  throw new Error(`Expected ${expected} admitted PostgreSQL backends, observed ${count}`);
}

/** Observe actual pool admission; no timing assumption decides when the barrier opens. */
export async function waitingClients(admin: pg.Client, database: string, minimum: number) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const result = await admin.query<{ database: string; cl_waiting: number }>("SHOW POOLS");
    const waiting = result.rows
      .filter((row) => row.database === database)
      .reduce((total, row) => total + Number(row.cl_waiting), 0);
    if (waiting >= minimum) return waiting;
  }
  throw new Error("The burst never reached the shared pool's queue");
}
