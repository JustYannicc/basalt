import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { BarrierRefusal } from "./refusal.ts";
import { releaseSchemaPlan } from "./release-preflight-schemas.ts";
import { loadRegistrySqlExpectations } from "./sql-schema-expectations.ts";
import type { SqlJournalSource } from "./sql-schema-read.ts";

const source = (database: PGlite): SqlJournalSource => ({
  databaseName: "postgres",
  connect: async () => ({
    query: (text, values) => database.query<Record<string, unknown>>(text, values),
    end: async () => {},
  }),
});
const blocked = (namespace: string) => (error: unknown) =>
  error instanceof BarrierRefusal &&
  error.reason === "release-preflight-schema-blocked" &&
  error.worker === `SQL.${namespace}`;

test("the release preflight names the migrations the release will apply and refuses journals it could not reach ready", async () => {
  const expected = Object.fromEntries(
    (await loadRegistrySqlExpectations()).map((entry) => [entry.namespace, entry.expected]),
  );
  const tools = new PGlite();
  const pool = new PGlite();
  try {
    for (const journal of ["private_hosted_migrations", "private_cloud_migrations"])
      await tools.exec(`CREATE TABLE ${journal} (migration_id integer PRIMARY KEY, name text)`);
    for (const [namespace, journal] of [
      ["hosted", "private_hosted_migrations"],
      ["cloud", "private_cloud_migrations"],
    ] as const)
      for (const marker of expected[namespace]!) {
        const [, id, name] = /^(\d+)_(.+)$/.exec(marker)!;
        await tools.query(`INSERT INTO ${journal} VALUES ($1, $2)`, [Number(id), name]);
      }
    for (const [namespace, journal] of [
      ["sdk", "private_executor_settings"],
      ["registry", "private_executor_public_apps_settings"],
    ] as const) {
      await tools.exec(`CREATE TABLE ${journal} (key text PRIMARY KEY, value text)`);
      await tools.query(`INSERT INTO ${journal} VALUES ('version', $1)`, [expected[namespace]![0]]);
    }
    // The pool as the previous release left it: every history marker except the candidate's newest.
    const history = expected["model-history"]!;
    await pool.exec("CREATE TABLE basalt_model_history_migrations (name text PRIMARY KEY)");
    for (const name of history.slice(0, -1))
      await pool.query("INSERT INTO basalt_model_history_migrations VALUES ($1)", [name]);
    const sources = { tools: source(tools), pool: source(pool) };

    assert.deepEqual(await releaseSchemaPlan(sources), {
      hosted: [],
      cloud: [],
      sdk: [],
      registry: [],
      "model-history": [history.at(-1)],
    });

    // A hole is not a state any previous release leaves; the barrier would refuse after the writes.
    await pool.query("DELETE FROM basalt_model_history_migrations WHERE name = $1", [history[0]]);
    await assert.rejects(releaseSchemaPlan(sources), blocked("model-history"));
    await pool.query("INSERT INTO basalt_model_history_migrations VALUES ($1)", [history[0]]);

    // A marker the candidate does not register means production is ahead of it.
    await pool.query(
      "INSERT INTO basalt_model_history_migrations VALUES ('model_request_history_v99_unknown')",
    );
    await assert.rejects(releaseSchemaPlan(sources), blocked("model-history"));
    await pool.query(
      "DELETE FROM basalt_model_history_migrations WHERE name = 'model_request_history_v99_unknown'",
    );

    await pool.query("INSERT INTO basalt_model_history_migrations VALUES ($1)", [history.at(-1)]);
    assert.deepEqual((await releaseSchemaPlan(sources))["model-history"], []);

    await tools.exec("DROP TABLE private_cloud_migrations");
    await assert.rejects(releaseSchemaPlan(sources), blocked("cloud"));
  } finally {
    await tools.close();
    await pool.close();
  }
});
