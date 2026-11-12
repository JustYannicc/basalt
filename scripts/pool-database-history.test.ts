import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { historySchemaMigrations } from "../src/pool/model-history/schema.ts";
import { provisionPoolDatabase, type Session } from "./pool-database-provisioning.ts";

for (const retained of [false, true]) {
  test(`release provisioning migrates ${retained ? "retained v2" : "fresh"} history and repeats safely`, async () => {
    const database = new PGlite();
    const statements: string[] = [];
    const scoped: Session = {
      query: async (text, values) => {
        statements.push(text);
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
    const release = () =>
      provisionPoolDatabase({
        runtimeLogin: "pool_runtime",
        connect: async (name) => (name === "pool" ? scoped : cluster),
        sleep: async () => {},
        log: () => {},
      });
    try {
      await scoped.query("CREATE ROLE basalt_pool_owner NOLOGIN");
      await scoped.query("ALTER SCHEMA public OWNER TO basalt_pool_owner");
      if (retained) {
        await scoped.query('SET ROLE "basalt_pool_owner"');
        await scoped.query(`CREATE TABLE basalt_model_history_migrations (
          name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        for (const migration of historySchemaMigrations.slice(0, 2)) {
          for (const sql of migration.statements) await scoped.query(sql);
          await scoped.query("INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", [
            migration.name,
          ]);
        }
        await scoped.query(
          `INSERT INTO basalt_model_requests
          (id,source,source_record,timestamp,timestamp_exact,token_quality,failed,cost_basis,attribution)
          VALUES ($1,$2,$3,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','legacy',false,'unpriced','unknown')`,
          ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
        );
        await scoped.query("RESET ROLE");
      }
      const before = retained
        ? (await scoped.query("SELECT * FROM basalt_model_requests")).rows
        : [];
      statements.length = 0;
      await release();
      assert.deepEqual(
        (await scoped.query("SELECT name FROM basalt_model_history_migrations ORDER BY name")).rows,
        historySchemaMigrations.map(({ name }) => ({ name })),
      );
      assert.equal(
        (await scoped.query("SELECT to_regclass('basalt_model_requests_account_time') AS index"))
          .rows[0]!.index,
        "basalt_model_requests_account_time",
      );
      assert.deepEqual((await scoped.query("SELECT * FROM basalt_model_traffic")).rows, []);
      assert.deepEqual((await scoped.query("SELECT * FROM basalt_model_history_cursor")).rows, []);
      assert.deepEqual((await scoped.query("SELECT * FROM basalt_model_requests")).rows, before);
      const applied = (
        await scoped.query("SELECT * FROM basalt_model_history_migrations ORDER BY name")
      ).rows;
      statements.length = 0;
      await release();
      assert.ok(
        !statements.some((sql) =>
          /^(?:ALTER TABLE|CREATE INDEX|CREATE TABLE basalt_model_)/.test(sql),
        ),
      );
      assert.deepEqual(
        (await scoped.query("SELECT * FROM basalt_model_history_migrations ORDER BY name")).rows,
        applied,
      );
      assert.deepEqual((await scoped.query("SELECT * FROM basalt_model_requests")).rows, before);
    } finally {
      await database.close();
    }
  });
}
