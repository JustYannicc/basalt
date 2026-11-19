import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { readPoolReliabilitySlo } from "../../src/pool/model-history/reliability-slo.ts";
import { historyMemoryOwnerFixture } from "./history-fixture.ts";

const now = Date.parse("2026-11-18T12:00:00Z"),
  at = new Date(now).toISOString();
const perDay = 2_880; // Two requests a minute, each with its start, finish and Home row.

/** A day of fully evidenced traffic, then one evidence gap or extra failures per case. */
async function pool(
  change: (
    db: HistoryDatabase,
    ids: { pool: string; home: string; person: string },
  ) => Promise<void>,
  failedEvery = 0,
) {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  await historyMemoryOwnerFixture(db);
  await migrateModelHistory(db);
  await db.query("CREATE TABLE usage (id bigint PRIMARY KEY)");
  const ids = {
    pool: (await digest("fixture")).slice(0, 16),
    home: await digest("home-local-v1"),
    person: await digest("fixture-person"),
  };
  await db.query(
    "UPDATE basalt_model_history_migrations SET completed_at = $1::timestamptz - interval '30 hours'",
    [at],
  );
  await db.query(
    `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
    SELECT md5('r'||g)::uuid,$2,$3,$3,'/v1/responses',$4::timestamptz - g * interval '30 seconds'
    FROM generate_series(1,$1::int) g`,
    [perDay, ids.pool, ids.person, at],
  );
  await db.query(
    `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
    SELECT request_id,'complete',200,1,started_at + interval '1 second' FROM basalt_model_terminal_starts`,
  );
  await db.query(
    `INSERT INTO basalt_model_requests
      (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
        token_quality,failed,status_code,cost_basis,attribution)
    SELECT encode(sha256(convert_to('h'||s.request_id,'UTF8')),'hex'),$1,
      encode(sha256(convert_to('hr'||s.request_id,'UTF8')),'hex'),s.started_at,
      to_char(s.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
      s.pool,$2,$2,s.request_id::text,'unclassified',
      $3::int > 0 AND row_number() OVER (ORDER BY s.started_at) % $3::int = 0,
      CASE WHEN $3::int > 0 AND row_number() OVER (ORDER BY s.started_at) % $3::int = 0
        THEN 500 ELSE 200 END,'unpriced','unknown'
    FROM basalt_model_terminal_starts s`,
    [ids.home, ids.person, failedEvery],
  );
  await db.query(
    `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
    VALUES ($1,0,0,0,true,0,$2::timestamptz)`,
    [ids.home, at],
  );
  await change(db, ids);
  try {
    return await readPoolReliabilitySlo(db, "fixture", now);
  } finally {
    await database.close();
  }
}

const lostFinish = (minutesAgo: number) => async (db: HistoryDatabase, ids: { pool: string }) => {
  await db.query(
    `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
    VALUES (md5('lost')::uuid,$1,NULL,NULL,'/v1/responses',$2::timestamptz - $3::int * interval '1 minute')`,
    [ids.pool, at, minutesAgo + 1],
  );
  await db.query(
    `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
    VALUES (md5('lost')::uuid,'unavailable',200,0,$1::timestamptz - $2::int * interval '1 minute')`,
    [at, minutesAgo],
  );
};

test("one lost terminal record is shown, and does not hold a clean day unavailable", async () => {
  const slo = await pool(lostFinish(1));
  assert.equal(slo.state, "ok", "120 clean requests an hour cannot be tipped by one unknown");
  assert.equal(slo.reason, undefined);
  assert.deepEqual(slo.hour.unknown, { requests: 1, pending: 0, unavailable: 1, unmatched: 0 });
  assert.deepEqual(slo.day.unknown, { requests: 1, pending: 0, unavailable: 1, unmatched: 0 });
});

test("an abandoned start and a Home row without evidence are counted by class", async () => {
  const slo = await pool(async (db, ids) => {
    await db.query(
      `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
      VALUES (md5('abandoned')::uuid,$1,NULL,NULL,'/v1/responses',$2::timestamptz - interval '30 minutes')`,
      [ids.pool, at],
    );
    await db.query(
      `INSERT INTO basalt_model_requests
        (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
          token_quality,failed,status_code,cost_basis,attribution)
      VALUES ($1,$2,$1,$3::timestamptz - interval '2 hours',
        to_char(($3::timestamptz - interval '2 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
        $4,$5,$5,'resp_without_terminal','unclassified',false,200,'unpriced','unknown')`,
      [await digest("unmatched"), ids.home, at, ids.pool, ids.person],
    );
  });
  assert.equal(slo.state, "ok");
  assert.deepEqual(slo.hour.unknown, { requests: 1, pending: 1, unavailable: 0, unmatched: 0 });
  assert.deepEqual(slo.day.unknown, { requests: 2, pending: 1, unavailable: 0, unmatched: 1 });
});

test("unknown outcomes that could tip the hour leave the figure unavailable", async () => {
  // One failure in each 120 requests: an hour at 99.2 % can fall below 99 % with one more failure.
  const slo = await pool(lostFinish(1), 120);
  assert.equal(slo.hour.real.failed, 1);
  assert.equal(slo.state, "unavailable");
  assert.equal(slo.reason, "terminal_collection_unavailable");
});

test("known failures that break the target are a breach even beside unknown outcomes", async () => {
  // About 1.4 % of the day failed: no unknown request could bring it back to 99 %.
  const slo = await pool(lostFinish(1), 72);
  assert.deepEqual(
    [slo.day.real.requests, slo.day.real.failed, slo.day.unknown?.requests],
    [2880, 40, 1],
  );
  assert.equal(slo.state, "breached");
  assert.equal(slo.reason, undefined);
});

/** Home rows without terminal evidence, already among the window's counted requests. */
const homeWithoutEvidence =
  (prefix: string, count: number, failed: boolean, spreadSeconds: number) =>
  async (db: HistoryDatabase, ids: { pool: string; home: string; person: string }) => {
    await db.query(
      `INSERT INTO basalt_model_requests
        (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
          token_quality,failed,status_code,cost_basis,attribution)
      SELECT encode(sha256(convert_to($8||g,'UTF8')),'hex'),$1,
        encode(sha256(convert_to($8||'record'||g,'UTF8')),'hex'),t.at,
        to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
        $2,$3,$3,'resp_'||$8||g,'unclassified',$5,CASE WHEN $5 THEN 500 ELSE 200 END,'unpriced','unknown'
      FROM generate_series(1,$4::int) g
      CROSS JOIN LATERAL (SELECT $6::timestamptz - g * $7::int * interval '1 second' AS at) t`,
      [ids.home, ids.pool, ids.person, count, failed, at, spreadSeconds, prefix],
    );
  };

test("unknown requests already counted do not dilute a real breach", async () => {
  // The hour's 162 counted requests include 2 failures (1.2 %) and 42 without terminal evidence.
  const slo = await pool(async (db, ids) => {
    await homeWithoutEvidence("ok", 40, false, 60)(db, ids);
    await homeWithoutEvidence("failed", 2, true, 600)(db, ids);
  });
  assert.deepEqual(
    [slo.hour.real.requests, slo.hour.real.failed, slo.hour.unknown?.requests],
    [162, 2, 42],
  );
  assert.equal(slo.state, "breached");
});

test("a Home row that already failed is not counted as a second possible failure", async () => {
  // 1 of the hour's 121 requests failed and is the only unknown one: 0.83 % even at worst.
  const slo = await pool(homeWithoutEvidence("failed", 1, true, 300));
  assert.deepEqual([slo.hour.real.requests, slo.hour.real.failed], [121, 1]);
  assert.equal(slo.state, "ok");
});

test("proof traffic's lost records do not count against the real objective", async () => {
  const slo = await pool(async (db, ids) => {
    const key = await digest("fixture-proof-key");
    await db.query(
      `INSERT INTO basalt_model_traffic (pool,source,client_key,purpose,evidence)
      VALUES ($1,$2,$3,'proof',$4)`,
      [ids.pool, ids.home, key, await digest("fixture-proof-evidence")],
    );
    await db.query(
      `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
      VALUES (md5('proof-abandoned')::uuid,$1,NULL,$2,'/v1/responses',$3::timestamptz - interval '30 minutes')`,
      [ids.pool, key, at],
    );
  });
  assert.equal(slo.hour.unknown?.requests, 0);
  assert.equal(slo.state, "ok");
});

test("a start still without a finish names the undecided figure as pending", async () => {
  const slo = await pool(async (db, ids) => {
    await db.query(
      `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
      VALUES (md5('abandoned')::uuid,$1,NULL,NULL,'/v1/responses',$2::timestamptz - interval '30 minutes')`,
      [ids.pool, at],
    );
  }, 120);
  assert.equal(slo.state, "unavailable");
  assert.equal(slo.reason, "terminal_collection_pending");
  assert.equal(slo.hour.unknown?.pending, 1);
});
