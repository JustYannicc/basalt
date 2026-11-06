import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDatabaseBackends } from "../verify-database-budget.ts";
import { connect, localDatabaseUrl, runtimeUrl } from "./database-budget/postgres.ts";
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
