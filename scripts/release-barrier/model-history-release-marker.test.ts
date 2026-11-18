import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { historySchemaMigrations } from "../../src/pool/model-history/schema.ts";
import { provisionPoolDatabase, type Session } from "../pool-database-provisioning.ts";
import { loadSqlSchemaExpectations } from "./sql-schema-expectations.ts";
import { readSqlSchemas } from "./sql-schema-read.ts";

// The barrier requires every history marker the candidate registers before it activates a worker,
// and only the release's own database phase applies them. A new history migration must therefore
// be applied by that phase, from the candidate's registry, to a database the previous release left.
test("the release database phase applies the candidate's newest history marker before the barrier requires it", async () => {
  const database = new PGlite();
  const scoped: Session = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    end: async () => {},
  };
  const cluster: Session = {
    query: async (text) => ({
      rows: text.includes("FROM pg_database")
        ? [{ owner: "basalt_pool_owner" }]
        : text.includes("rolsuper")
          ? [{ rolcanlogin: false, rolsuper: false }]
          : [{}],
      rowCount: 1,
    }),
    end: async () => {},
  };
  try {
    // Production as the previous release left it: every marker except the candidate's newest.
    await scoped.query("CREATE ROLE basalt_pool_owner NOLOGIN");
    await scoped.query("ALTER SCHEMA public OWNER TO basalt_pool_owner");
    await scoped.query('SET ROLE "basalt_pool_owner"');
    await scoped.query(`CREATE TABLE basalt_model_history_migrations (
      name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    for (const migration of historySchemaMigrations.slice(0, -1)) {
      for (const sql of migration.statements) await scoped.query(sql);
      await scoped.query("INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", [
        migration.name,
      ]);
    }
    await scoped.query("RESET ROLE");

    const expectations = await loadSqlSchemaExpectations(73);
    const newest = historySchemaMigrations.at(-1)!.name;
    assert.equal(
      expectations.find((entry) => entry.namespace === "model-history")!.expected.at(-1),
      newest,
    );
    const history = async () =>
      (
        await readSqlSchemas({
          candidate: "b".repeat(40),
          homeImageDigest: `sha256:${"c".repeat(64)}`,
          expectations,
          sources: {
            tools: {
              databaseName: "postgres",
              connect: async () => {
                throw Object.assign(new Error("tools database is outside this proof"), {
                  code: "08006",
                });
              },
            },
            pool: {
              databaseName: "postgres",
              connect: async () => ({
                query: async (text, values) =>
                  database.query<Record<string, unknown>>(text, values),
                end: async () => {},
              }),
            },
          },
        })
      ).observations.find((entry) => entry.namespace === "model-history")!;

    const before = await history();
    assert.equal(before.status, "pending");
    assert.deepEqual(before.pending, [newest]);

    await provisionPoolDatabase({
      runtimeLogin: "pool_runtime",
      connect: async (name) => (name === "pool" ? scoped : cluster),
      sleep: async () => {},
      log: () => {},
    });
    const after = await history();
    assert.equal(after.status, "ready");
    assert.deepEqual(after.pending, []);
    assert.deepEqual(after.unexpected, []);
    assert.ok(after.expected.every((name) => after.applied!.includes(name)));
  } finally {
    await database.close();
  }
});
