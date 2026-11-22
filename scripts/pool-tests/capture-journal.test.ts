import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { backendUserName } from "../../src/pool/backend-users.ts";
import { activateHomeBackfill, planHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { historyBatchSize, historyForwardPages } from "../../src/pool/model-history/store.ts";
import {
  deliverPoolHistoryChanges,
  readPoolHistoryChanges,
} from "../../src/pool/model-history/change-revisions.ts";
import {
  activateModelHistoryJournal,
  migrateModelHistory,
  type HistoryDatabase,
} from "../../src/pool/model-history/schema.ts";
import {
  historyMemoryOwnerFixture,
  historySchemaFixture,
  homeMetadataFixture,
} from "./history-fixture.ts";

const admin = process.env.POOL_TEST_ADMIN_URL;
if (admin && !["127.0.0.1", "localhost"].includes(new URL(admin).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to isolated local test Postgres");
const pool = "app_capture_journal";
const fingerprint = `sha256:${"a".repeat(64)}`;
const usageHint = (revision: string) => [
  {
    scope: `pool:${pool}`,
    hint: { topic: "pool-usage", resource: pool, revision },
  },
];

async function fixture(work: (db: HistoryDatabase) => Promise<void>) {
  const schema = `capture_journal_${randomUUID().replaceAll("-", "")}`;
  const client = admin ? new pg.Client({ connectionString: admin }) : null;
  const memory = client ? null : new PGlite();
  const db: HistoryDatabase = client ?? {
    query: async (text, values) => {
      const result = await memory!.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    if (client) {
      await client.connect();
      const version = Number(
        (await db.query("show server_version_num")).rows[0]!.server_version_num,
      );
      assert.ok(version >= 170000 && version < 180000, "These proofs require PostgreSQL 17");
      await historySchemaFixture(db, schema);
      await db.query(`SET search_path TO ${schema}`);
      await db.query("SET ROLE basalt_pool_owner");
    } else {
      await historyMemoryOwnerFixture(db);
    }
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    await activateModelHistoryJournal(db);
    assert.deepEqual(await readPoolHistoryChanges(db, pool), [
      { topic: "pool-readings", resource: pool, revision: "0" },
      { topic: "pool-usage", resource: pool, revision: "0" },
    ]);
    await db.query('INSERT INTO "user" VALUES(1,$1)', [await backendUserName("person", pool)]);
    await db.query("INSERT INTO api_key VALUES(1,$1,1,NULL)", [fingerprint]);
    const baseline = await captureHomeRequests(db);
    await deliverPoolHistoryChanges(db, baseline.pending, async () => {});
    await work(db);
  } finally {
    if (client) {
      try {
        await client.query("ROLLBACK").catch(() => {});
        await client.query("RESET ROLE");
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await client.end();
      }
    } else {
      await memory!.close();
    }
  }
}

const addUsage = (db: HistoryDatabase, id: number) =>
  db.query(
    `INSERT INTO usage(id,timestamp,request_id,api_key)
    VALUES($1,'2026-01-01T00:00:00Z',$2,$3)`,
    [id, `attempt-${id}`, fingerprint],
  );

async function durable(db: HistoryDatabase) {
  const rows = await db.query(`SELECT request_id,pool,source,source_record
    FROM basalt_model_requests ORDER BY request_id`);
  const cursor = await db.query(`SELECT forward_id::text,backfill_upper::text,
    backfill_id::text,backfill_complete,sweep_id::text,sweep_upper::text
    FROM basalt_model_history_cursor`);
  return { rows: rows.rows, cursor: cursor.rows };
}

async function queueState(db: HistoryDatabase) {
  return (
    await db.query(
      `SELECT
    basalt_pool_change_revision($1,'pool-usage')::text AS logical,
    (SELECT revision::text FROM basalt_pool_change_heads WHERE pool=$1 AND topic='pool-usage') AS physical,
    (SELECT revision::text FROM basalt_pool_change_pending WHERE pool=$1 AND topic='pool-usage') AS pending,
    (SELECT count(*)::int FROM basalt_pool_change_batches) AS batches,
    (SELECT count(*)::int FROM basalt_pool_change_dirty) AS dirty`,
      [pool],
    )
  ).rows[0];
}

function recorded(db: HistoryDatabase, before?: (sql: string) => void) {
  const statements: string[] = [];
  const wrapper: HistoryDatabase = {
    query: async (text, values) => {
      const sql = text.trim().replaceAll(/\s+/g, " ");
      statements.push(sql);
      before?.(sql);
      return db.query(text, values);
    },
  };
  return { wrapper, statements };
}

test("one capture run takes exactly the forward bound the reliability objective allows", () =>
  fixture(async (db) => {
    const run = historyForwardPages * historyBatchSize;
    await addUsage(db, 1);
    await activateHomeBackfill(db, await planHomeBackfill(db));
    await db.query(
      `INSERT INTO usage(id,timestamp,request_id,api_key)
      SELECT n,'2026-01-01T00:00:00Z','attempt-' || n,$1 FROM generate_series(2,$2::int) n`,
      [fingerprint, run + 2],
    );
    await captureHomeRequests(db);
    assert.equal((await durable(db)).cursor[0]?.forward_id, String(1 + run));
    await captureHomeRequests(db);
    assert.equal((await durable(db)).cursor[0]?.forward_id, String(run + 2));
  }));

test("activated journal leaves unchanged inactive capture at five statements", () =>
  fixture(async (db) => {
    const { wrapper, statements } = recorded(db);
    assert.deepEqual(await captureHomeRequests(wrapper), { state: "inactive", pending: [] });
    assert.equal(statements.length, 5);
    assert.equal(statements[0], "BEGIN");
    assert.equal(statements.at(-1), "COMMIT");
    assert.equal(
      statements.some((sql) => sql.includes("basalt_pool_project_changes")),
      false,
    );
    assert.deepEqual(await queueState(db), {
      logical: "0",
      physical: "0",
      pending: null,
      batches: 0,
      dirty: 0,
    });
  }));

test("capture commits history and cursor before projection failure and a fresh capture recovers exactly once", () =>
  fixture(async (db) => {
    await addUsage(db, 1);
    await activateHomeBackfill(db, await planHomeBackfill(db));
    const failure = new Error("controlled projector begin failure");
    let failures = 0;
    const broken = recorded(db, (sql) => {
      if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED" && failures === 0) {
        failures++;
        throw failure;
      }
    });
    await assert.rejects(captureHomeRequests(broken.wrapper), (error) => error === failure);
    assert.equal(failures, 1);
    const projectionBegin = broken.statements.indexOf("BEGIN ISOLATION LEVEL READ COMMITTED");
    assert.ok(projectionBegin > 0);
    assert.equal(broken.statements[projectionBegin - 1], "COMMIT");
    assert.equal(broken.statements.at(-1), "ROLLBACK");
    const committed = await durable(db);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    assert.deepEqual(committed.rows, [
      {
        request_id: "attempt-1",
        pool: hash(pool).slice(0, 16),
        source: hash("home-local-v1"),
        source_record: hash(JSON.stringify(["usage", "1"])),
      },
    ]);
    assert.deepEqual(committed.cursor, [
      {
        forward_id: "1",
        backfill_upper: "1",
        backfill_id: "1",
        backfill_complete: true,
        sweep_id: "0",
        sweep_upper: "0",
      },
    ]);
    assert.deepEqual(await queueState(db), {
      logical: "1",
      physical: "0",
      pending: null,
      batches: 1,
      dirty: 1,
    });
    assert.deepEqual(
      (await readPoolHistoryChanges(db, pool)).find((hint) => hint.topic === "pool-usage"),
      { topic: "pool-usage", resource: pool, revision: "1" },
    );

    const fresh = recorded(db);
    const recovered = await captureHomeRequests(fresh.wrapper);
    assert.equal(recovered.state, "active");
    assert.equal("inserted" in recovered && recovered.inserted, 0);
    assert.deepEqual(recovered.pending, usageHint("1"));
    const retryBegin = fresh.statements.indexOf("BEGIN ISOLATION LEVEL READ COMMITTED");
    assert.ok(retryBegin > 0);
    assert.equal(fresh.statements[retryBegin - 1], "COMMIT");
    assert.deepEqual(await durable(db), committed);
    assert.deepEqual(await queueState(db), {
      logical: "1",
      physical: "1",
      pending: "1",
      batches: 0,
      dirty: 0,
    });

    const unchanged = recorded(db);
    const repeated = await captureHomeRequests(unchanged.wrapper);
    assert.equal("inserted" in repeated && repeated.inserted, 0);
    assert.deepEqual(repeated.pending, usageHint("1"));
    assert.equal(unchanged.statements.includes("BEGIN ISOLATION LEVEL READ COMMITTED"), false);
    await deliverPoolHistoryChanges(db, recovered.pending, async (changes) => {
      assert.deepEqual(changes, usageHint("1"));
    });
    assert.deepEqual((await captureHomeRequests(db)).pending, []);
    assert.deepEqual(await durable(db), committed);
    assert.deepEqual(await queueState(db), {
      logical: "1",
      physical: "1",
      pending: null,
      batches: 0,
      dirty: 0,
    });
  }));

test("delivery failure retains pending and an old acknowledgement preserves a newer capture projected during publish", () =>
  fixture(async (db) => {
    await addUsage(db, 1);
    await activateHomeBackfill(db, await planHomeBackfill(db));
    const first = await captureHomeRequests(db);
    assert.deepEqual(first.pending, usageHint("1"));
    const failed = new Error("controlled publish failure");
    await assert.rejects(
      deliverPoolHistoryChanges(db, first.pending, async (changes) => {
        assert.deepEqual(changes, usageHint("1"));
        throw failed;
      }),
      (error) => error === failed,
    );
    assert.deepEqual(await queueState(db), {
      logical: "1",
      physical: "1",
      pending: "1",
      batches: 0,
      dirty: 0,
    });

    let publications = 0;
    await deliverPoolHistoryChanges(db, first.pending, async (changes) => {
      publications++;
      assert.deepEqual(changes, usageHint("1"));
      await addUsage(db, 2);
      const newer = await captureHomeRequests(db);
      assert.equal("inserted" in newer && newer.inserted, 1);
      assert.deepEqual(newer.pending, usageHint("2"));
      assert.deepEqual(await queueState(db), {
        logical: "2",
        physical: "2",
        pending: "2",
        batches: 0,
        dirty: 0,
      });
    });
    assert.equal(publications, 1);
    assert.deepEqual(await queueState(db), {
      logical: "2",
      physical: "2",
      pending: "2",
      batches: 0,
      dirty: 0,
    });
    const retained = await captureHomeRequests(db);
    assert.equal("inserted" in retained && retained.inserted, 0);
    assert.deepEqual(retained.pending, usageHint("2"));
    assert.deepEqual(
      (await durable(db)).rows.map((row) => row.request_id),
      ["attempt-1", "attempt-2"],
    );
    await deliverPoolHistoryChanges(db, retained.pending, async (changes) => {
      assert.deepEqual(changes, usageHint("2"));
    });
    assert.deepEqual(await queueState(db), {
      logical: "2",
      physical: "2",
      pending: null,
      batches: 0,
      dirty: 0,
    });
    assert.deepEqual((await captureHomeRequests(db)).pending, []);
  }));
