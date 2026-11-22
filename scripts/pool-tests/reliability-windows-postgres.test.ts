import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { digest } from "../../src/pool/backend-users.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { readPoolReliabilityWindows } from "../../src/pool/model-history/reliability.ts";
import { historySchemaFixture } from "./history-fixture.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");

// The production pool's day on 18 Nov: about 21,600 finished requests with their Home rows, a few
// hundred gateway refusals, and about a hundred finishes whose Home row hadn't arrived yet. Two such
// days, plus older imported history.
const perDay = 21_600,
  refusalsPerDay = 400,
  awaitingPerDay = 111,
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
      // Production's database runs without JIT compilation.
      await db.query("SET jit = off");
      await historySchemaFixture(db, schema);
      await db.query(`SET search_path TO ${schema}`);
      await migrateModelHistory(db);
      const at = new Date(now).toISOString();
      const pool = (await digest("fixture")).slice(0, 16);
      const [home, gateway] = await Promise.all([
        digest("home-local-v1"),
        digest("pool-gateway-v1"),
      ]);
      const person = await digest("fixture-person");
      const spacing = (perDay: number) => 86_400 / perDay;
      await db.query(
        "UPDATE basalt_model_history_migrations SET completed_at = $1::timestamptz - interval '49 hours'",
        [at],
      );
      // Finished requests: those with prefix r get Home rows below, those with prefix a don't yet.
      for (const [prefix, count] of [
        ["r", perDay],
        ["a", awaitingPerDay],
      ] as const) {
        await db.query(
          `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
          SELECT md5($6||g)::uuid,$2,$3,$3,'/v1/responses',$4::timestamptz - g * $5::float8 * interval '1 second'
          FROM generate_series(1,$1::int) g`,
          [count * 2, pool, person, at, spacing(count), prefix],
        );
      }
      await db.query(
        `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
        SELECT request_id,'complete',200,1,started_at + interval '1 second'
        FROM basalt_model_terminal_starts`,
      );
      const insertHome = (
        source: string,
        prefix: string,
        count: number,
        time: string,
        failedEvery: number,
      ) =>
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
          [source, pool, prefix, person, count, at, failedEvery, spacing(count / 2)],
        );
      await insertHome(
        home,
        "r",
        perDay * 2,
        "$6::timestamptz - g * $8::float8 * interval '1 second'",
        1_000,
      );
      await insertHome(
        gateway,
        "g",
        refusalsPerDay * 2,
        "$6::timestamptz - g * $8::float8 * interval '1 second'",
        1,
      );
      // $8 is unused here, but every parameter needs a type.
      await insertHome(
        home,
        "o",
        olderRows,
        "$6::timestamptz - interval '49 hours' - g * interval '2 seconds' + 0 * $8::float8 * interval '1 second'",
        0,
      );
      await db.query(
        "ANALYZE basalt_model_requests, basalt_model_terminal_starts, basalt_model_terminal_finishes",
      );

      let windows: Explained | undefined;
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
      // The read's own transaction and limit.
      await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL statement_timeout = '5s'");
      const [hour, day, current] = await readPoolReliabilityWindows(
        observed,
        "fixture",
        [3_600_000, 86_400_000, 300_000].map((duration) => ({
          from: new Date(now - duration).toISOString(),
          to: at,
        })),
        true,
      );
      await db.query("ROLLBACK");
      assert.ok(hour && day && current);
      // Every finished request counts once, through its Home row or its finish, beside the refusals.
      assert.ok(
        Math.abs(day.real.requests - (perDay + awaitingPerDay + refusalsPerDay)) < 50,
        `day requests: ${day.real.requests}`,
      );
      assert.ok(windows);
      const blocks = windows.Plan["Shared Hit Blocks"] + windows.Plan["Shared Read Blocks"];
      // Probing all 16 Home partitions for a refusal before the cheap check against the day's Home
      // rows took this statement past 5 s on a copy of production, at about 145 buffers per request of
      // the day; here it touched about 110, and with the probe fenced off but every Home attempt
      // looked up by key, 13.
      assert.ok(blocks < 10 * perDay, `windows statement buffers: ${blocks}`);
      // Half the 5 s limit: 231–324 ms on an idle machine, 1,029 ms and 1,224 ms on loaded runners.
      assert.ok(
        windows["Execution Time"] < 2_500,
        `windows statement: ${Math.round(windows["Execution Time"])} ms`,
      );
    } finally {
      await db.query("ROLLBACK").catch(() => {});
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  },
);
