import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Effect, Redacted } from "effect";
import pg from "pg";
import { accountChangeSetup } from "./account-change-fixture.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const PgClient: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pg/dist/PgClient.js") =
  await import(require.resolve("@effect/sql-pg/PgClient"));
const adminUrl = process.env.POOL_TEST_ADMIN_URL;
export const localPostgres =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
export const owner = "organization:team-a";

/** The production SDK schema and migrations, with three independent PostgreSQL sessions. */
export async function postgresChanges(
  work: (clients: { a: pg.Client; b: pg.Client; observer: pg.Client }) => Promise<void>,
) {
  assert.ok(
    localPostgres,
    "POOL_TEST_ADMIN_URL must name an isolated loopback PostgreSQL database",
  );
  const schema = `change_lock_${randomUUID().replaceAll("-", "")}`;
  const observer = new pg.Client({ connectionString: adminUrl });
  await observer.connect();
  await observer.query(`create schema ${schema}`);
  const a = new pg.Client({
    connectionString: adminUrl,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c deadlock_timeout=100`,
  });
  const b = new pg.Client({
    connectionString: adminUrl,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c deadlock_timeout=100`,
  });
  try {
    await Effect.runPromise(
      accountChangeSetup.pipe(
        Effect.provide(
          PgClient.layer({
            url: Redacted.make(adminUrl!),
            maxConnections: 1,
            startupParameters: { search_path: schema },
          }),
        ),
      ),
    );
    await Promise.all([a.connect(), b.connect()]);
    await observer.query(`set search_path=${schema}`);
    await a.query(
      "insert into hosted_provisioning (organization_id,status,attempts,updated_at) values ('team-a','running',1,now())",
    );
    await a.query("delete from hosted_change_pending");
    await work({ a, b, observer });
  } finally {
    await Promise.all([a.query("rollback").catch(() => {}), b.query("rollback").catch(() => {})]);
    await Promise.all([a.end(), b.end()]);
    await observer.query(`drop schema ${schema} cascade`);
    await observer.end();
  }
}

export async function pid(client: pg.Client) {
  return Number((await client.query("select pg_backend_pid() as pid")).rows[0].pid);
}

/** The server's actual lock graph opens the barrier; time is only a failure bound. */
export async function blockedOrDone(
  observer: pg.Client,
  waiter: number,
  blocker: number,
  done: () => boolean,
) {
  const deadline = performance.now() + 5000;
  while (!done()) {
    const result = await observer.query(
      "select $2::int=any(pg_blocking_pids($1::int)) as blocked",
      [waiter, blocker],
    );
    if (result.rows[0].blocked) return;
    assert.ok(performance.now() < deadline, "The requested PostgreSQL lock overlap never occurred");
  }
}

export async function transaction(client: pg.Client, work: () => Promise<void>) {
  try {
    await client.query("begin");
    await work();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
export const code = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : String(error);
