import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetFixture } from "./database-budget/fixture.ts";
import { connect, runtimeUrl, runtimeBackends } from "./database-budget/postgres.ts";
import { verifyDatabaseBudget, backendCountSql } from "../database-budget-verification.ts";

test(
  "downsizing drains old idle servers naturally and fails visibly for an open transaction",
  {
    skip: !process.env.POOL_TEST_POOLED_URL,
    timeout: 15_000,
  },
  async (t) => {
    const fixture = await budgetFixture("drain");
    const clients: Awaited<ReturnType<typeof connect>>[] = [];
    try {
      await fixture.pooler.query("SET max_db_connections=10");
      await fixture.pooler.query("SET default_pool_size=10");
      await Promise.all(
        Array.from({ length: 7 }, async (_, i) => {
          const client = await connect(
            runtimeUrl(fixture.pooled, fixture.database, i % 2 ? "budget_b" : "budget_a"),
          );
          clients.push(client);
          await client.query("BEGIN");
          await client.query("SELECT pg_backend_pid()");
        }),
      );
      assert.equal(await runtimeBackends(fixture.admin, [fixture.database]), 7);
      await fixture.pooler.query("SET max_db_connections=5");
      await fixture.pooler.query("SET default_pool_size=5");
      // Same managed parameters, shortened to exercise retirement without a minute-long test.
      await fixture.pooler.query("SET server_lifetime=2");
      await fixture.pooler.query("SET server_idle_timeout=1");
      const read = async () =>
        (await fixture.admin.query(backendCountSql, [["budget_a", "budget_b"]])).rows;
      await assert.rejects(
        verifyDatabaseBudget({ databases: [fixture.database], deadlineMs: 0, read }),
        /did not converge/,
      );
      const start = performance.now();
      await Promise.all(clients.map((client) => client.query("COMMIT")));
      const counts = await verifyDatabaseBudget({
        databases: [fixture.database],
        deadlineMs: 5_000,
        read,
      });
      assert.ok(counts.every((row) => row.connections <= 5));
      const results = await Promise.all(clients.map((client) => client.query("SELECT 1 AS alive")));
      assert.ok(results.every((result) => result.rows[0]?.alive === 1));
      t.diagnostic(
        JSON.stringify({ warmBackends: 7, convergenceMs: performance.now() - start, counts }),
      );
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      for (const [name, value] of Object.entries({
        max_db_connections: 5,
        default_pool_size: 5,
        server_lifetime: 3600,
        server_idle_timeout: 600,
      })) {
        await fixture.pooler.query(`SET ${name}=${value}`);
      }
      await fixture.close();
    }
  },
);
