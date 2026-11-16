import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { inspectSqlSchema } from "./sql-schema-inspection.ts";
import { readSqlSnapshot } from "./sql-schema-read.ts";
import type { SqlJournalSource } from "./sql-schema-read.ts";

const tooling = "a".repeat(40);
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE private_executor_settings(key text,value text);
    INSERT INTO private_executor_settings VALUES('version','4.0.30'),('password','private-row-secret');
    CREATE TABLE private_hosted_migrations(migration_id integer,name text);
    INSERT INTO private_hosted_migrations VALUES(1,'private-marker-name'),(22,'activate');
    CREATE TABLE private_cloud_migrations(migration_id integer,name text);
    INSERT INTO private_cloud_migrations VALUES(3,'private-cloud-name');
    CREATE TABLE "user"(id text,email text,"emailVerified" boolean);
    INSERT INTO "user" VALUES('private-user','private-email',true);`);
  const statements: string[] = [];
  const source: SqlJournalSource = {
    databaseName: "postgres",
    connect: async () => ({
      query: async (sql, values) => {
        statements.push(sql);
        return db.query<Record<string, unknown>>(sql, values);
      },
      end: async () => {},
    }),
  };
  const read = () => inspectSqlSchema({ selection: "schema-v1", tooling, source });
  return { db, source, read, statements };
}

test("fixed inspection observes journals and auth columns in a read-only snapshot without data rows", async () => {
  const f = await fixture();
  try {
    const receipt = await f.read();
    assert.equal(receipt.status, "complete");
    assert.deepEqual(receipt.journals.find((v) => v.namespace === "sdk")?.versions, ["4.0.30"]);
    assert.deepEqual(receipt.journals.find((v) => v.namespace === "hosted")?.migrationIds, [1, 22]);
    assert.deepEqual(receipt.auth.find((v) => v.table === "user")?.columns, [
      "id",
      "email",
      "emailVerified",
    ]);
    assert.equal(receipt.auth.find((v) => v.table === "session")?.status, "missing");
    assert.doesNotMatch(JSON.stringify(receipt), /private-|password/);
    assert.equal(f.statements.filter((s) => s.startsWith("BEGIN")).length, 1);
    assert.ok(f.statements.find((s) => s.startsWith("BEGIN"))?.endsWith("READ ONLY"));
    assert.ok(
      f.statements.every((s) => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE)/u.test(s)),
    );
    assert.ok(f.statements.every((s) => !/SELECT\s+\*/iu.test(s)));
  } finally {
    await f.db.close();
  }
});

test("unknown selection and invalid tooling refuse before opening a connection", async () => {
  let connects = 0;
  const source: SqlJournalSource = {
    databaseName: "postgres",
    connect: async () => {
      connects++;
      throw new Error("must not connect");
    },
  };
  for (const options of [
    { selection: "arbitrary-sql", tooling },
    { selection: "schema-v1", tooling: "main" },
  ])
    await assert.rejects(() => inspectSqlSchema({ ...options, source }), /inspection-input/u);
  assert.equal(connects, 0);
});

test("marker overflow and malformed version retain no partial values", async () => {
  const f = await fixture();
  try {
    await f.db
      .exec(`INSERT INTO private_hosted_migrations SELECT v,'not-exported' FROM generate_series(23,279) v;
      UPDATE private_executor_settings SET value='credential-shaped-private-value' WHERE key='version';`);
    const receipt = await f.read();
    assert.equal(receipt.status, "incomplete");
    assert.equal(receipt.journals.find((v) => v.namespace === "hosted")?.status, "unreadable");
    assert.equal(receipt.journals.find((v) => v.namespace === "sdk")?.status, "unreadable");
    assert.doesNotMatch(JSON.stringify(receipt), /credential-shaped|not-exported/);
  } finally {
    await f.db.close();
  }
});

test("an absent Executor version cannot produce a complete inspection", async () => {
  const f = await fixture();
  try {
    await f.db.exec("DELETE FROM private_executor_settings WHERE key='version'");
    const receipt = await f.read();
    assert.equal(receipt.status, "incomplete");
    assert.equal(receipt.journals.find((v) => v.namespace === "sdk")?.status, "unreadable");
  } finally {
    await f.db.close();
  }
});

test("views cannot act as journals and driver messages stay private", async () => {
  const f = await fixture();
  try {
    await f.db.exec(
      "DROP TABLE private_cloud_migrations; CREATE VIEW private_cloud_migrations AS SELECT 3 AS migration_id;",
    );
    const receipt = await f.read();
    assert.equal(receipt.journals.find((v) => v.namespace === "cloud")?.status, "unreadable");
    const failed = await inspectSqlSchema({
      selection: "schema-v1",
      tooling,
      source: {
        databaseName: "postgres",
        connect: async () => {
          throw new Error("password=private-driver-secret");
        },
      },
    });
    assert.equal(failed.status, "incomplete");
    assert.doesNotMatch(JSON.stringify(failed), /private-driver-secret|password/u);
  } finally {
    await f.db.close();
  }
});

test("the shared snapshot rejects a database write and rolls it back", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      readSqlSnapshot(f.source, async (session) => {
        await session.query("INSERT INTO private_hosted_migrations VALUES(99,'blocked')");
      }),
      /Schema snapshot unavailable/u,
    );
    assert.deepEqual(
      (await f.db.query("SELECT migration_id FROM private_hosted_migrations ORDER BY migration_id"))
        .rows,
      [{ migration_id: 1 }, { migration_id: 22 }],
    );
    assert.equal(f.statements.includes("COMMIT"), false);
    assert.equal(f.statements.at(-1), "ROLLBACK");
  } finally {
    await f.db.close();
  }
});

test("auth column overflow is unavailable rather than a truncated column list", async () => {
  const f = await fixture();
  try {
    await f.db.exec(
      `CREATE TABLE session(${Array.from({ length: 65 }, (_, i) => `c${i} text`).join(",")});`,
    );
    const receipt = await f.read();
    const table = receipt.auth.find((v) => v.table === "session");
    assert.equal(table?.status, "unreadable");
    assert.equal(table?.columns, undefined);
    assert.equal(receipt.status, "incomplete");
  } finally {
    await f.db.close();
  }
});
