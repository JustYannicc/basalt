import assert from "node:assert/strict";
import { test } from "node:test";
import { homeProcess } from "./database-budget/home-process.ts";
import {
  connect,
  localDatabaseUrl,
  runtimeBackends,
  runtimeUrl,
  waitingClients,
  waitForBackendCount,
} from "./database-budget/postgres.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { hasActiveHomeApiKey } from "../../src/pool/model-auth.ts";

const binary = process.env.POOL_TEST_HOME_BUDGET_CLIENT;

test(
  "independent Home processes and model lookups share one database budget without missing deadlines",
  {
    skip: !binary,
    timeout: 60_000,
  },
  async (t) => {
    const direct = localDatabaseUrl(process.env.POOL_TEST_ADMIN_URL);
    const pooled = localDatabaseUrl(process.env.POOL_TEST_POOLED_URL);
    const admin = await connect(direct);
    const consoleUrl = new URL(pooled);
    consoleUrl.pathname = "/pgbouncer";
    const pooler = await connect(consoleUrl);
    const databases = [`budget0314_pool_${process.pid}`, `budget0314_app_${process.pid}`];
    const children: Awaited<ReturnType<typeof homeProcess>>[] = [];
    try {
      for (const role of ["basalt_pool_owner", "budget_a", "budget_b"]) {
        const found = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
        if (!found.rowCount)
          await admin.query(
            role === "basalt_pool_owner"
              ? "CREATE ROLE basalt_pool_owner NOLOGIN"
              : `CREATE ROLE ${role} LOGIN PASSWORD 'fixture-only'`,
          );
      }
      await admin.query("GRANT basalt_pool_owner TO budget_a,budget_b WITH INHERIT TRUE, SET TRUE");
      for (const database of databases)
        await admin.query(`CREATE DATABASE ${database} OWNER basalt_pool_owner`);
      const config = await pooler.query<{ key: string; value: string }>("SHOW CONFIG");
      assert.equal(config.rows.find((row) => row.key === "max_db_connections")?.value, "5");
      assert.equal(config.rows.find((row) => row.key === "pool_mode")?.value, "transaction");

      const first = await homeProcess(binary!, runtimeUrl(pooled, databases[0]!, "budget_a"));
      children.push(first);
      const migrated = await first.request("migrate");
      assert.equal(migrated.ok, true, migrated.error ?? "Home migration failed");
      const initialized = await first.request("initialize");
      assert.equal(initialized.ok, true, initialized.error ?? "Home initialization failed");
      const controlUrl = new URL(direct);
      controlUrl.pathname = "/" + databases[0];
      const control = await connect(controlUrl);
      try {
        const history = await connect(runtimeUrl(pooled, databases[0]!, "budget_b"));
        try {
          await migrateModelHistory(history);
          await migrateModelHistory(history);
          assert.equal(
            (await history.query("SELECT current_user AS role")).rows[0].role,
            "budget_b",
          );
        } finally {
          await history.end();
        }
        const owners = await control.query<{ owner: string }>(
          "SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace='public'::regnamespace",
        );
        assert.deepEqual(owners.rows, [{ owner: "basalt_pool_owner" }]);
        for (const count of [1, 2, 8]) {
          while (children.length < count) {
            children.push(
              await homeProcess(
                binary!,
                runtimeUrl(pooled, databases[0]!, children.length % 2 ? "budget_b" : "budget_a"),
              ),
            );
          }
          await control.query("BEGIN");
          await control.query("LOCK TABLE lifecycle_config IN ACCESS EXCLUSIVE MODE");
          const requests = children.flatMap((child) =>
            Array.from({ length: 6 }, () => child.request("update")),
          );
          try {
            const queued = await waitingClients(pooler, databases[0]!, 1);
            const connections = await waitForBackendCount(admin, [databases[0]!], 5);
            assert.equal(
              connections,
              5,
              "All runtime logins share the database's five server connections",
            );
            await control.query("COMMIT");
            const results = await Promise.all(requests);
            for (const result of results) {
              assert.equal(result.ok, true, result.error ?? "Home operation failed");
              assert.ok(
                result.elapsedMs < 2_500,
                "Queued Home work must finish inside its client deadline",
              );
            }
            t.diagnostic(
              JSON.stringify({
                processes: count,
                requests: results.length,
                queued,
                backendPeak: connections,
                maximumMs: Math.max(...results.map((result) => result.elapsedMs)),
              }),
            );
          } finally {
            await control.query("ROLLBACK");
            await Promise.allSettled(requests);
          }
        }

        await control.query("BEGIN");
        await control.query("LOCK TABLE api_key IN ACCESS EXCLUSIVE MODE");
        const lookups = Array.from({ length: 60 }, async (_, index) => {
          const started = performance.now();
          const active = await hasActiveHomeApiKey(runtimeUrl(pooled, databases[0]!, "budget_a"), [
            "missing-" + index,
          ]);
          return { active, elapsedMs: performance.now() - started };
        });
        try {
          const queued = await waitingClients(pooler, databases[0]!, 10);
          // Clients can queue while the fifth server connection is still logging in.
          await waitForBackendCount(admin, [databases[0]!], 5);
          assert.equal(await runtimeBackends(admin, [databases[0]!]), 5);
          await control.query("COMMIT");
          const results = await Promise.all(lookups);
          assert.ok(results.every((result) => result.active === false && result.elapsedMs < 6_000));
          t.diagnostic(
            JSON.stringify({
              modelLookups: results.length,
              queued,
              maximumMs: Math.max(...results.map((result) => result.elapsedMs)),
            }),
          );
        } finally {
          await control.query("ROLLBACK");
          await Promise.allSettled(lookups);
        }
        const app = await homeProcess(binary!, runtimeUrl(pooled, databases[1]!, "budget_a"));
        children.push(app);
        assert.equal((await app.request("migrate")).ok, true);
        assert.equal((await app.request("initialize")).ok, true);
        const appControlUrl = new URL(direct);
        appControlUrl.pathname = "/" + databases[1];
        const appControl = await connect(appControlUrl);
        try {
          await control.query("BEGIN");
          await control.query("LOCK TABLE lifecycle_config IN ACCESS EXCLUSIVE MODE");
          await appControl.query("BEGIN");
          await appControl.query("LOCK TABLE lifecycle_config IN ACCESS EXCLUSIVE MODE");
          const both = [children[0]!, app].flatMap((child) =>
            Array.from({ length: 6 }, () => child.request("update")),
          );
          try {
            await Promise.all(databases.map((database) => waitingClients(pooler, database, 1)));
            const connections = await waitForBackendCount(admin, databases, 10);
            assert.equal(
              connections,
              10,
              "Two logical databases have one combined ten-backend allocation",
            );
            await Promise.all([control.query("COMMIT"), appControl.query("COMMIT")]);
            const results = await Promise.all(both);
            assert.ok(results.every((result) => result.ok && result.elapsedMs < 2_500));
            t.diagnostic(
              JSON.stringify({
                databases: 2,
                combinedPeak: connections,
                maximumMs: Math.max(...results.map((result) => result.elapsedMs)),
              }),
            );
          } finally {
            await Promise.all([control.query("ROLLBACK"), appControl.query("ROLLBACK")]);
            await Promise.allSettled(both);
          }
        } finally {
          await appControl.end();
        }
      } finally {
        await control.end();
      }
    } finally {
      await Promise.all(children.map((child) => child.close()));
      for (const database of databases)
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await pooler.end();
      await admin.end();
    }
  },
);
