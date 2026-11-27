import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { readPoolReliabilitySlo } from "../../src/pool/model-history/reliability-slo.ts";
import { historyMemoryOwnerFixture, homeMetadataFixture } from "./history-fixture.ts";

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
  await homeMetadataFixture(db);
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
  // The lost request has no Home row, so the window never counted it, and it could have failed.
  const lost = {
    requests: 1,
    pending: 0,
    unavailable: 1,
    unmatched: 0,
    uncounted: 1,
    couldFail: 1,
  };
  assert.deepEqual(slo.hour.unknown, lost);
  assert.deepEqual(slo.day.unknown, lost);
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
  assert.deepEqual(slo.hour.unknown, {
    requests: 1,
    pending: 1,
    unavailable: 0,
    unmatched: 0,
    uncounted: 1,
    couldFail: 1,
  });
  // The unmatched Home row is already counted; the abandoned start is not.
  assert.deepEqual(slo.day.unknown, {
    requests: 2,
    pending: 1,
    unavailable: 0,
    unmatched: 1,
    uncounted: 1,
    couldFail: 2,
  });
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

/** A request finished without an observable outcome, with its latest Home attempt at another time. */
const straddling =
  (finishMinutesAgo: number, homeMinutesAgo: number, homeFailed: boolean) =>
  async (db: HistoryDatabase, ids: { pool: string; home: string; person: string }) => {
    await db.query(
      `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
      VALUES (md5('straddle')::uuid,$1,$2,$2,'/v1/responses',$3::timestamptz - $4::float8 * interval '1 minute')`,
      [ids.pool, ids.person, at, Math.max(finishMinutesAgo, homeMinutesAgo) + 0.5],
    );
    await db.query(
      `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
      VALUES (md5('straddle')::uuid,'unavailable',200,0,$1::timestamptz - $2::float8 * interval '1 minute')`,
      [at, finishMinutesAgo],
    );
    await db.query(
      `INSERT INTO basalt_model_requests
        (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
          token_quality,failed,status_code,cost_basis,attribution)
      SELECT $1,$2,$1,t.at,to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
        $3,$4,$4,md5('straddle')::uuid::text,'unclassified',$5,CASE WHEN $5 THEN 500 ELSE 200 END,
        'unpriced','unknown'
      FROM (SELECT $6::timestamptz - $7::float8 * interval '1 minute' AS at) t`,
      [await digest("straddle"), ids.home, ids.pool, ids.person, homeFailed, at, homeMinutesAgo],
    );
  };

test("an unknown request is weighed in the window that counts its latest Home attempt", async () => {
  // Finished just before the hour, its successful Home attempt landed just inside it: the hour counts
  // that success, which could be a second failure in 121 requests.
  const inside = await pool(straddling(60.5, 59.5, false), 120);
  assert.equal(inside.state, "unavailable");
  assert.deepEqual(inside.hour.unknown, {
    requests: 1,
    pending: 0,
    unavailable: 1,
    unmatched: 0,
    uncounted: 0,
    couldFail: 1,
  });
});

test("a request that finished unavailable before the day is weighed where its Home attempt is", async () => {
  // 28 of the day's 2,881 requests failed: one more possible failure leaves it undecided.
  const slo = await pool(straddling(25 * 60, 23 * 60, false), 102);
  assert.equal(slo.state, "unavailable");
  assert.deepEqual([slo.day.real.requests, slo.day.real.failed], [2881, 28]);
  assert.deepEqual(slo.day.unknown, {
    requests: 1,
    pending: 0,
    unavailable: 1,
    unmatched: 0,
    uncounted: 0,
    couldFail: 1,
  });
});

test("an unknown request whose latest Home attempt is before the hour is not weighed in it", async () => {
  // Its failed Home attempt landed just before the hour: the day counts that failure, and the hour
  // holds nothing of the request.
  const before = await pool(straddling(59.5, 60.5, true), 120);
  assert.equal(before.state, "ok");
  assert.equal(before.hour.unknown?.requests, 0);
  assert.deepEqual(before.day.unknown, {
    requests: 1,
    pending: 0,
    unavailable: 1,
    unmatched: 0,
    uncounted: 0,
    couldFail: 0,
  });
});

test("proof traffic's lost records do not count against the real objective", async () => {
  // At 99.2 % one more possible failure would leave the hour undecided.
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
  }, 120);
  assert.equal(slo.state, "ok");
  assert.equal(slo.hour.unknown?.requests, 0);
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
