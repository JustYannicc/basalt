import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { assertSqlSchemas, type SqlSchemaExpectation } from "./sql-schema-contract.ts";
import { readSqlSchemas, type SqlJournalSession } from "./sql-schema-read.ts";

const candidate = "b".repeat(40);
const image = `sha256:${"c".repeat(64)}`;
const expectations: SqlSchemaExpectation[] = [
  {
    namespace: "hosted",
    database: "tools",
    journal: "private_hosted_migrations",
    kind: "markers",
    expected: ["1_base", "2_latest"],
  },
  {
    namespace: "cloud",
    database: "tools",
    journal: "private_cloud_migrations",
    kind: "markers",
    expected: ["1_cloud"],
  },
  {
    namespace: "sdk",
    database: "tools",
    journal: "private_executor_settings",
    kind: "version",
    expected: ["4.0.29"],
    registered: ["4.0.28", "4.0.29"],
  },
  {
    namespace: "registry",
    database: "tools",
    journal: "private_executor_public_apps_settings",
    kind: "version",
    expected: ["2.0.0"],
    registered: ["1.0.0", "2.0.0"],
  },
  {
    namespace: "model-history",
    database: "pool",
    journal: "basalt_model_history_migrations",
    kind: "markers",
    expected: ["history_v1", "history_v2"],
  },
  {
    namespace: "home",
    database: "pool",
    journal: "home_schema_migration",
    kind: "home",
    expected: ["16"],
  },
];

async function fixture() {
  const tools = new PGlite();
  const pool = new PGlite();
  await tools.exec(`CREATE TABLE private_hosted_migrations(migration_id integer PRIMARY KEY,name text);
    INSERT INTO private_hosted_migrations VALUES(1,'base'),(2,'latest');
    CREATE TABLE private_cloud_migrations(migration_id integer PRIMARY KEY,name text);
    INSERT INTO private_cloud_migrations VALUES(1,'cloud');
    CREATE TABLE private_executor_settings(key text PRIMARY KEY,value text);
    INSERT INTO private_executor_settings VALUES('version','4.0.29'),('unrelated','private-fixture-not-read');
    CREATE TABLE private_executor_public_apps_settings(key text PRIMARY KEY,value text);
    INSERT INTO private_executor_public_apps_settings VALUES('version','2.0.0');`);
  await pool.exec(`CREATE TABLE basalt_model_history_migrations(name text PRIMARY KEY);
    INSERT INTO basalt_model_history_migrations VALUES('history_v1'),('history_v2');
    CREATE TABLE home_schema_migration(id bigint PRIMARY KEY,version bigint);
    INSERT INTO home_schema_migration VALUES(1,16);`);
  const statements: string[] = [];
  let denyCloud = false;
  const session = (database: PGlite): SqlJournalSession => ({
    query: async (text, values) => {
      statements.push(text);
      if (denyCloud && text.startsWith("SELECT migration_id, name FROM public.private_cloud"))
        throw Object.assign(new Error("password=fixture-secret host=private-fixture.example"), {
          code: "42501",
        });
      return database.query<Record<string, unknown>>(text, values);
    },
    end: async () => {},
  });
  const read = async () => {
    const receipt = await readSqlSchemas({
      candidate,
      homeImageDigest: image,
      expectations,
      sources: {
        tools: { databaseName: "postgres", connect: async () => session(tools) },
        pool: { databaseName: "postgres", connect: async () => session(pool) },
      },
    });
    receipt.home = {
      imageDigest: image,
      targetVersion: 16,
      expectedIndexes: [],
      readyIndexes: [],
      pendingIndexes: [],
      status: "ready",
      observedAt: new Date().toISOString(),
    };
    return receipt;
  };
  return {
    tools,
    pool,
    read,
    statements,
    denyCloud: () => {
      denyCloud = true;
    },
    close: () => Promise.all([tools.close(), pool.close()]),
  };
}

test("all six actual journals pass bounded read-only snapshots without reading other settings", async () => {
  const f = await fixture();
  try {
    const receipt = await f.read();
    assert.equal(receipt.observations.length, 6);
    assert.doesNotThrow(() => assertSqlSchemas(receipt, candidate));
    assert.ok(
      f.statements
        .filter((sql) => sql.includes("BEGIN TRANSACTION"))
        .every((sql) => sql.endsWith("READ ONLY")),
    );
    assert.ok(
      f.statements.every(
        (sql) => !/^(?:CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)/.test(sql),
      ),
    );
    assert.doesNotMatch(JSON.stringify(receipt), /private-fixture-not-read/);
  } finally {
    await f.close();
  }
});

test("a missing lower marker refuses with exact namespace and version even when the latest exists", async () => {
  const f = await fixture();
  try {
    await f.tools.query("DELETE FROM private_hosted_migrations WHERE migration_id=1");
    const receipt = await f.read();
    assert.equal(receipt.observations.length, 6);
    assert.deepEqual(receipt.observations.find((entry) => entry.namespace === "hosted")!.pending, [
      "1_base",
    ]);
    assert.throws(() => assertSqlSchemas(receipt, candidate), /hosted.*1_base/);
  } finally {
    await f.close();
  }
});

test("one unreadable journal retains expected versions and all other outcomes without driver text", async () => {
  const f = await fixture();
  try {
    f.denyCloud();
    const receipt = await f.read();
    const cloud = receipt.observations.find((entry) => entry.namespace === "cloud")!;
    assert.equal(cloud.status, "unreadable");
    assert.deepEqual(cloud.expected, ["1_cloud"]);
    assert.equal(cloud.applied, null);
    assert.equal(cloud.pending, null);
    assert.equal(cloud.sqlState, "42501");
    assert.equal(receipt.observations.filter((entry) => entry.status === "ready").length, 5);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-secret|private-fixture\.example/);
    assert.throws(
      () => assertSqlSchemas(receipt, candidate),
      /cloud.*1_cloud.*applied=unknown.*42501/,
    );
  } finally {
    await f.close();
  }
});

test("a missing journal or same-named view cannot establish a schema version", async () => {
  const f = await fixture();
  try {
    await f.pool.exec(
      "DROP TABLE home_schema_migration; CREATE VIEW home_schema_migration AS SELECT 1::bigint AS id,16::bigint AS version;",
    );
    const receipt = await f.read();
    assert.equal(
      receipt.observations.find((entry) => entry.namespace === "home")!.reason,
      "journal-type",
    );
    assert.throws(() => assertSqlSchemas(receipt, candidate), /home.*journal-type/);
    await f.pool.exec("DROP VIEW home_schema_migration");
    const missing = await f.read();
    assert.equal(missing.observations.find((entry) => entry.namespace === "home")!.pending, null);
  } finally {
    await f.close();
  }
});
