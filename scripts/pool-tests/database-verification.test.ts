import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDatabaseBackends } from "../verify-database-budget.ts";
import { connect, localDatabaseUrl, runtimeUrl } from "./database-budget/postgres.ts";

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
