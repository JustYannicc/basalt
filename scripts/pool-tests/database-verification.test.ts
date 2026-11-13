import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDatabaseBackends } from "../verify-database-budget.ts";
import {
  connect,
  localDatabaseUrl,
  runtimeUrl,
  runtimeBackends,
  waitForBackendCount,
} from "./database-budget/postgres.ts";
import { budgetFixture } from "./database-budget/fixture.ts";

test(
  "the deployed verification reads real runtime backends and refuses excess sessions at its deadline",
  {
    skip: !process.env.POOL_TEST_POOLED_URL,
    timeout: 15_000,
  },
  async () => {
    const direct = localDatabaseUrl(process.env.POOL_TEST_ADMIN_URL);
    const admin = await connect(direct);
    const role = `budget_verify_${process.pid}`;
    const database = `budget0314_verify_${process.pid}`;
    const clients: Awaited<ReturnType<typeof connect>>[] = [];
    try {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fixture-only'`);
      await admin.query(`CREATE DATABASE ${database}`);
      for (let index = 0; index < 6; index++)
        clients.push(await connect(runtimeUrl(direct, database, role)));
      await assert.rejects(
        checkDatabaseBackends({
          adminUrl: direct.toString(),
          runtimeLogins: [role],
          databases: [database],
          deadlineMs: 50,
        }),
        /did not converge/,
      );
      await clients.pop()!.end();
      const counts = await checkDatabaseBackends({
        adminUrl: direct.toString(),
        runtimeLogins: [role],
        databases: [database],
        deadlineMs: 1_000,
      });
      assert.deepEqual(counts, [{ database, connections: 5 }]);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  },
);

test(
  "the verifier counts direct plus pooled sessions per database and refuses incomplete visibility",
  {
    skip: !process.env.POOL_TEST_POOLED_URL,
    timeout: 15_000,
  },
  async () => {
    const fixture = await budgetFixture("verify");
    const { admin, direct, pooled } = fixture;
    // PgBouncer's CI auth file registers this shared fixture login.
    const role = "budget_a";
    const monitor = `budget0348_monitor_${process.pid}`;
    const databases = [
      fixture.database,
      `budget0348_b_${process.pid}`,
      `budget0348_zero_${process.pid}`,
    ];
    const clients: Awaited<ReturnType<typeof connect>>[] = [];
    try {
      await admin.query(`CREATE ROLE ${monitor} LOGIN PASSWORD 'fixture-only'`);
      for (const database of databases.slice(1)) await admin.query(`CREATE DATABASE ${database}`);
      for (let index = 0; index < 3; index++)
        clients.push(await connect(runtimeUrl(direct, databases[0]!, role)));
      for (let index = 0; index < 3; index++) {
        const client = await connect(runtimeUrl(pooled, databases[0]!, role));
        clients.push(client);
        await client.query("BEGIN");
        await client.query("SELECT pg_backend_pid()");
      }
      for (let index = 0; index < 2; index++)
        clients.push(await connect(runtimeUrl(direct, databases[1]!, role)));
      const { DatabaseBudgetFailure } = await import("../database-budget-receipt.ts");
      await assert.rejects(
        checkDatabaseBackends({
          adminUrl: direct.toString(),
          runtimeLogins: [role],
          databases,
          deadlineMs: 0,
          now: () => 0,
        }),
        (error) => {
          assert.ok(error instanceof DatabaseBudgetFailure);
          assert.equal(error.receipt.outcome, "over-budget-deadline");
          assert.deepEqual(
            error.receipt.counts,
            databases.map((database, index) => ({ database, connections: [6, 2, 0][index] })),
          );
          return true;
        },
      );
      await clients.shift()!.end();
      assert.deepEqual(
        await checkDatabaseBackends({
          adminUrl: direct.toString(),
          runtimeLogins: [role],
          databases,
          deadlineMs: 0,
          now: () => 0,
        }),
        databases.map((database, index) => ({ database, connections: [5, 2, 0][index] })),
      );
      await assert.rejects(
        checkDatabaseBackends({
          adminUrl: runtimeUrl(direct, "postgres", monitor),
          runtimeLogins: [role],
          databases,
          deadlineMs: 0,
          now: () => 0,
        }),
        (error) =>
          error instanceof DatabaseBudgetFailure &&
          error.receipt.outcome === "incomplete-visibility" &&
          error.receipt.counts === null,
      );
    } finally {
      for (const client of clients) {
        await client.query("ROLLBACK").catch(() => {});
        await client.end();
      }
      for (const database of databases.slice(1))
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${monitor}`);
      await fixture.close();
    }
  },
);

test(
  "the fixture counts client connections, excludes parallel workers and refuses a real sixth backend",
  { skip: !process.env.POOL_TEST_POOLED_URL, timeout: 15_000 },
  async (t) => {
    const fixture = await budgetFixture("counter");
    const clients: Awaited<ReturnType<typeof connect>>[] = [];
    let running: Promise<unknown> | undefined;
    let leader: number | undefined;
    try {
      for (let index = 0; index < 5; index++) {
        const client = await connect(runtimeUrl(fixture.pooled, fixture.database, "budget_a"));
        clients.push(client);
        await client.query("BEGIN");
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        leader = pid.rows[0]!.pid;
      }
      assert.equal(await waitForBackendCount(fixture.admin, [fixture.database], 5), 5);
      const last = clients.at(-1)!;
      await last.query("SET LOCAL max_parallel_workers_per_gather=1");
      await last.query("SET LOCAL debug_parallel_query=on");
      // Cancellation ends the worker after observation; the sleep never decides success.
      running = last.query("SELECT pg_sleep(10)").catch(() => {});
      const deadline = performance.now() + 2_000;
      let worker = false;
      while (performance.now() < deadline) {
        const found = await fixture.admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE leader_pid=$1 AND backend_type='parallel worker'",
          [leader],
        );
        if (found.rowCount) {
          worker = true;
          break;
        }
      }
      assert.ok(worker, "The regression must observe an actual parallel worker");
      const raw = await fixture.admin.query<{ connections: number }>(
        "SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname=$1 AND usename='budget_a'",
        [fixture.database],
      );
      assert.equal(raw.rows[0]!.connections, 6, "The unfiltered activity view includes the worker");
      const types = await fixture.admin.query<{ kind: string; count: number }>(
        "SELECT backend_type AS kind,count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND usename='budget_a' GROUP BY backend_type ORDER BY backend_type",
        [fixture.database],
      );
      assert.deepEqual(types.rows, [
        { kind: "client backend", count: 5 },
        { kind: "parallel worker", count: 1 },
      ]);
      assert.equal(await runtimeBackends(fixture.admin, [fixture.database]), 5);
      t.diagnostic(
        JSON.stringify({
          unfiltered: raw.rows[0]!.connections,
          types: types.rows,
          runtimeClients: 5,
        }),
      );
      await fixture.admin.query("SELECT pg_cancel_backend($1)", [leader]);
      await running;
      running = undefined;
      await last.query("ROLLBACK");
      await last.query("BEGIN");
      await last.query("SELECT pg_backend_pid()");
      const direct = await connect(runtimeUrl(fixture.direct, fixture.database, "budget_b"));
      try {
        assert.equal(await runtimeBackends(fixture.admin, [fixture.database]), 6);
        await assert.rejects(
          waitForBackendCount(fixture.admin, [fixture.database], 5),
          /Expected 5 admitted PostgreSQL backends, observed 6/,
        );
      } finally {
        await direct.end();
      }
      assert.equal(await waitForBackendCount(fixture.admin, [fixture.database], 5), 5);
    } finally {
      if (running && leader !== undefined) {
        await fixture.admin.query("SELECT pg_cancel_backend($1)", [leader]);
        await running;
      }
      await Promise.all(clients.map((client) => client.end()));
      await fixture.close();
    }
  },
);
