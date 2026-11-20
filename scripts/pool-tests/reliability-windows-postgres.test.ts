import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { digest } from "../../src/pool/backend-users.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { readPoolReliabilitySlo } from "../../src/pool/model-history/reliability-slo.ts";
import { historySchemaFixture } from "./history-fixture.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");

// Production's daily volume on 18 Nov, the day before it, and older imported history. Every recent
// request has its start, finish and Home row.
const perDay = 14_600,
  olderRows = 200_000;
const now = Date.parse("2026-11-18T22:00:00Z");

interface Explained {
  "Execution Time": number;
  Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
}

test(
  "the reliability windows statement stays well inside its 5 s limit at production's daily volume",
  { timeout: 600_000 },
  async () => {
    const schema = `reliability_${randomUUID().replaceAll("-", "")}`;
    const db = new pg.Client({ connectionString: adminUrl });
    await db.connect();
    try {
      await historySchemaFixture(db, schema);
      await db.query(`SET search_path TO ${schema}`);
      await migrateModelHistory(db);
      await db.query("CREATE TABLE usage (id bigint PRIMARY KEY)");
      const at = new Date(now).toISOString();
      const pool = (await digest("fixture")).slice(0, 16);
      const home = await digest("home-local-v1");
      const person = await digest("fixture-person");
      const step = 86_400 / perDay;
      await db.query(
        "UPDATE basalt_model_history_migrations SET completed_at = $1::timestamptz - interval '49 hours'",
        [at],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
        SELECT md5('r'||g)::uuid,$2,$3,$3,'/v1/responses',$4::timestamptz - g * $5::float8 * interval '1 second'
        FROM generate_series(1,$1::int) g`,
        [perDay * 2, pool, person, at, step],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
        SELECT request_id,'complete',200,1,started_at + interval '1 second'
        FROM basalt_model_terminal_starts`,
      );
      const insertHome = (count: number, prefix: string, time: string, failedEvery: number) =>
        db.query(
          `INSERT INTO basalt_model_requests
            (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
              token_quality,failed,status_code,cost_basis,attribution)
          SELECT encode(sha256(convert_to($3||g,'UTF8')),'hex'),$1,
            encode(sha256(convert_to($3||'record'||g,'UTF8')),'hex'),t.at,
            to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
            $2,$4,$4,md5($3||g)::uuid::text,'unclassified',$7::int > 0 AND g % $7::int = 0,
            CASE WHEN $7::int > 0 AND g % $7::int = 0 THEN 500 ELSE 200 END,'unpriced','unknown'
          FROM generate_series(1,$5::int) g
          CROSS JOIN LATERAL (SELECT ${time} AS at) t`,
          [home, pool, prefix, person, count, at, failedEvery, step],
        );
      await insertHome(
        perDay * 2,
        "r",
        "$6::timestamptz - g * $8::float8 * interval '1 second'",
        1_000,
      );
      // $8 is unused here, but every parameter needs a type.
      await insertHome(
        olderRows,
        "o",
        "$6::timestamptz - interval '49 hours' - g * interval '2 seconds' + 0 * $8::float8 * interval '1 second'",
        0,
      );
      await db.query(
        `INSERT INTO basalt_model_history_cursor
          (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
        VALUES ($1,0,0,0,true,0,$2::timestamptz)`,
        [home, at],
      );
      await db.query(
        "ANALYZE basalt_model_requests, basalt_model_terminal_starts, basalt_model_terminal_finishes",
      );

      let windows: Explained | undefined;
      // The statement is explained inside the read's own transaction, under the read's own settings.
      const observed: HistoryDatabase = {
        query: async (text, values) => {
          if (text.includes("FROM selected r JOIN ranges ON")) {
            const explained = await db.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
              values,
            );
            [windows] = explained.rows[0]["QUERY PLAN"];
          }
          return db.query(text, values);
        },
      };
      const slo = await readPoolReliabilitySlo(observed, "fixture", now);
      assert.equal(slo.state, "ok");
      assert.ok(slo.day.real.requests > 0.99 * perDay, `day requests: ${slo.day.real.requests}`);
      assert.ok(windows);
      const blocks = windows.Plan["Shared Hit Blocks"] + windows.Plan["Shared Read Blocks"];
      // About 2 s of JIT compilation alone made this statement take 2.5 to 3.1 s on Postgres 17.
      assert.ok(
        windows["Execution Time"] < 1_000,
        `windows statement: ${Math.round(windows["Execution Time"])} ms`,
      );
      // Probing all 16 Home partitions for each finish of the day touched about 100 buffers per request.
      assert.ok(blocks < 40 * perDay, `windows statement buffers: ${blocks}`);
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  },
);
