import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { readPoolReliabilitySlo } from "../../src/pool/model-history/reliability-slo.ts";
import { historyMemoryOwnerFixture } from "./history-fixture.ts";

// Shaped like the production pool: imported history far larger than the terminal evidence.
const olderRows = 100_000,
  requests = 4_000;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Join Filter"?: number;
  Plans?: PlanNode[];
}

function readsTerminal(node: PlanNode): boolean {
  return (
    (node["Relation Name"] ?? "").startsWith("basalt_model_terminal_") ||
    (node.Plans ?? []).some(readsTerminal)
  );
}

/** Terminal evidence rows handed to the plan across all loops; a materialized copy counts per read. */
function terminalRows(node: PlanNode): number {
  const handed =
    (node["Actual Rows"] +
      (node["Rows Removed by Filter"] ?? 0) +
      (node["Rows Removed by Join Filter"] ?? 0)) *
    node["Actual Loops"];
  if (node["Node Type"] === "Materialize" && readsTerminal(node)) return handed;
  const own = (node["Relation Name"] ?? "").startsWith("basalt_model_terminal_") ? handed : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + terminalRows(child), 0);
}

test(
  "the terminal evidence check reads each Home row's evidence by key, not every start per row",
  { timeout: 300_000 },
  async () => {
    const database = new PGlite();
    const db: HistoryDatabase = {
      query: async (text, values) => {
        const result = await database.query<Record<string, unknown>>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    };
    try {
      await historyMemoryOwnerFixture(db);
      await migrateModelHistory(db);
      await db.query("CREATE TABLE usage (id bigint PRIMARY KEY)");
      const now = Date.parse("2026-11-18T12:00:00Z"),
        at = new Date(now).toISOString();
      const pool = (await digest("fixture")).slice(0, 16);
      const home = await digest("home-local-v1");
      const person = await digest("fixture-person");
      // Terminal evidence began 30 hours ago; every request since has its start, finish and Home row.
      await db.query(
        "UPDATE basalt_model_history_migrations SET completed_at = $1::timestamptz - interval '30 hours'",
        [at],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
        SELECT md5('r'||g)::uuid,$2,$3,$3,'/v1/responses',$4::timestamptz - g * interval '27 seconds'
        FROM generate_series(1,$1::int) g`,
        [requests, pool, person, at],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
        SELECT request_id,'complete',200,1,started_at + interval '1 second'
        FROM basalt_model_terminal_starts`,
      );
      const insertHome = (count: number, prefix: string, from: string, idSql: string) =>
        db.query(
          `INSERT INTO basalt_model_requests
            (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
              token_quality,failed,status_code,cost_basis,attribution)
          SELECT encode(sha256(convert_to($3||g,'UTF8')),'hex'),$1,
            encode(sha256(convert_to($3||'record'||g,'UTF8')),'hex'),t.at,
            to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
            $2,$4,$4,${idSql},'unclassified',false,200,'unpriced','unknown'
          FROM generate_series(1,$5::int) g
          CROSS JOIN LATERAL (SELECT ${from} AS at) t`,
          [home, pool, prefix, person, count, at],
        );
      await insertHome(
        requests,
        "r",
        "$6::timestamptz - g * interval '27 seconds'",
        "md5('r'||g)::uuid::text",
      );
      await insertHome(
        olderRows,
        "o",
        "$6::timestamptz - interval '31 hours' - g * interval '20 seconds'",
        "md5('o'||g)::uuid::text",
      );
      await db.query(
        `INSERT INTO basalt_model_history_cursor
          (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
        VALUES ($1,0,0,0,true,0,$2::timestamptz)`,
        [home, at],
      );
      await db.query("ANALYZE");

      let statement: { text: string; values?: unknown[] } | undefined;
      const recorded: HistoryDatabase = {
        query: (text, values) => {
          if (text.includes("unknown(class,id,at)")) statement = { text, values };
          return db.query(text, values);
        },
      };
      const slo = await readPoolReliabilitySlo(recorded, "fixture", now);
      assert.equal(slo.reason, undefined);
      assert.deepEqual(
        slo.day.unknown,
        { requests: 0, pending: 0, unavailable: 0, unmatched: 0 },
        "every Home row in the window has its evidence",
      );
      assert.equal(slo.day.real.requests, Math.ceil(86_400 / 27));
      assert.ok(statement);

      const explained = await db.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
        statement.values,
      );
      const [explain] = explained.rows;
      assert.ok(explain);
      const [root] = explain["QUERY PLAN"] as { Plan: PlanNode }[];
      assert.ok(root);
      const read = terminalRows(root.Plan);
      // Comparing each Home row's id as text against every start read about 6.4 million rows here.
      assert.ok(read < 5 * requests, `terminal evidence rows read: ${read}`);

      // One Home row in the window without evidence is shown, and cannot tip 3,200 clean requests.
      await insertHome(
        1,
        "missing",
        "$6::timestamptz - interval '1 minute'",
        "md5('missing')::uuid::text",
      );
      const gap = await readPoolReliabilitySlo(db, "fixture", now);
      assert.equal(gap.state, "ok");
      assert.equal(gap.day.unknown?.unmatched, 1);
    } finally {
      await database.close();
    }
  },
);

test("a Home row is matched to its evidence only by its exact canonical id, and no id fails the read", async () => {
  const now = Date.parse("2026-11-18T12:00:00Z"),
    at = new Date(now).toISOString();
  const evidence = "0b5d6f3c-1a2b-4c3d-8e9f-a1b2c3d4e5f6";
  for (const [label, homeId, available] of [
    ["the start's own id", evidence, true],
    ["the start's id in upper case", evidence.toUpperCase(), false],
    ["the start's id in braces", `{${evidence}}`, false],
    ["an id that is no UUID", `resp_${evidence}`, false],
  ] as const) {
    const database = new PGlite();
    const db: HistoryDatabase = {
      query: async (text, values) => {
        const result = await database.query<Record<string, unknown>>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    };
    try {
      await historyMemoryOwnerFixture(db);
      await migrateModelHistory(db);
      await db.query("CREATE TABLE usage (id bigint PRIMARY KEY)");
      const pool = (await digest("fixture")).slice(0, 16);
      const home = await digest("home-local-v1");
      const person = await digest("fixture-person");
      await db.query(
        "UPDATE basalt_model_history_migrations SET completed_at = $1::timestamptz - interval '30 hours'",
        [at],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
        VALUES ($1::uuid,$2,$3,$3,'/v1/responses',$4::timestamptz - interval '2 minutes')`,
        [evidence, pool, person, at],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
        VALUES ($1::uuid,'complete',200,1,$2::timestamptz - interval '1 minute')`,
        [evidence, at],
      );
      const row = await digest(`row-${label}`);
      await db.query(
        `INSERT INTO basalt_model_requests
          (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
            token_quality,failed,status_code,cost_basis,attribution)
        VALUES ($1,$2,$1,$3::timestamptz - interval '2 minutes',
          to_char(($3::timestamptz - interval '2 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
          $4,$5,$5,$6,'unclassified',false,200,'unpriced','unknown')`,
        [row, home, at, pool, person, homeId],
      );
      await db.query(
        `INSERT INTO basalt_model_history_cursor
          (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
        VALUES ($1,0,0,0,true,0,$2::timestamptz)`,
        [home, at],
      );
      const slo = await readPoolReliabilitySlo(db, "fixture", now);
      if (available) assert.equal(slo.reason, undefined, label);
      else assert.equal(slo.reason, "terminal_collection_unavailable", label);
    } finally {
      await database.close();
    }
  }
});
