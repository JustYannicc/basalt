import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { readPoolReliabilityWindows } from "../../src/pool/model-history/reliability.ts";
import { historyMemoryOwnerFixture } from "./history-fixture.ts";

const now = Date.parse("2026-11-18T21:00:00Z");
// Shaped like the production pool: an imported history far larger than one day of traffic.
const historyRows = 100_000,
  importedRows = 40_000,
  oldTerminals = 20_000,
  dayRows = 2_880;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "CTE Name"?: string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/** Rows each table's scans examined, including rows their filters discarded. */
function rowsRead(node: PlanNode, into = new Map<string, number>(), indexes = new Set<string>()) {
  const name = node["Relation Name"] ?? (node["CTE Name"] && `cte ${node["CTE Name"]}`);
  if (name) {
    const table = name.replace(/_\d+$/, "");
    const examined =
      (node["Actual Rows"] +
        (node["Rows Removed by Filter"] ?? 0) +
        (node["Rows Removed by Index Recheck"] ?? 0)) *
      node["Actual Loops"];
    into.set(table, (into.get(table) ?? 0) + examined);
    indexes.add(`${table}:${node["Node Type"]}:${node["Index Name"] ?? "-"}`);
  }
  for (const child of node.Plans ?? []) rowsRead(child, into, indexes);
  return { into, indexes };
}

test(
  "the SLO read examines one day of rows however long the pool's history is",
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
      const pool = (await digest("fixture")).slice(0, 16);
      const home = await digest("home-local-v1");
      const imported = await digest("fixture-import");
      const person = await digest("fixture-person");
      const at = new Date(now).toISOString();
      const insert = (count: number, source: string, prefix: string, ageSql: string) =>
        db.query(
          `INSERT INTO basalt_model_requests
          (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
            token_quality,failed,status_code,cost_basis,attribution)
        SELECT encode(sha256(convert_to($3||g,'UTF8')),'hex'),$2,
          encode(sha256(convert_to($3||'record'||g,'UTF8')),'hex'),t.at,
          to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
          $4,$5,$5,md5($3||g)::uuid::text,'unclassified',g % 100 = 0,
          CASE WHEN g % 100 = 0 THEN 500 ELSE 200 END,'unpriced','unknown'
        FROM generate_series(1,$1::int) g
        CROSS JOIN LATERAL (SELECT $6::timestamptz - ${ageSql} AS at) t`,
          [count, source, prefix, pool, person, at],
        );
      await insert(historyRows, home, "old-", "interval '2 days' - g * interval '1 minute'");
      await insert(importedRows, imported, "import-", "g * interval '3 minutes'");
      await insert(dayRows, home, "day-", "g * interval '30 seconds'");
      // Every day row and the oldest history rows have terminal evidence finishing one second later.
      for (const [prefix, count] of [
        ["day-", dayRows],
        ["old-", oldTerminals],
      ] as const) {
        await db.query(
          `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
          SELECT md5($2||g)::uuid,$3,$4,$4,'/v1/responses',r.timestamp
          FROM generate_series(1,$1::int) g
          JOIN basalt_model_requests r ON r.id=encode(sha256(convert_to($2||g,'UTF8')),'hex')`,
          [count, prefix, pool, person],
        );
        await db.query(
          `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
          SELECT s.request_id,'complete',200,1,s.started_at + interval '1 second'
          FROM generate_series(1,$1::int) g
          JOIN basalt_model_terminal_starts s ON s.request_id=md5($2||g)::uuid`,
          [count, prefix],
        );
      }
      // A request whose only Home attempt precedes the day window but which finished inside it, and a
      // window row without a request identity.
      const earlier = await digest("fixture-earlier");
      await db.query(
        `INSERT INTO basalt_model_requests
          (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
            token_quality,failed,status_code,cost_basis,attribution)
        VALUES ($1,$2,$1,$3::timestamptz - interval '25 hours',
          to_char(($3::timestamptz - interval '25 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
          $4,$5,$5,md5('earlier')::uuid::text,'unclassified',false,200,'unpriced','unknown'),
          ($6,$2,$6,$3::timestamptz - interval '10 minutes',
          to_char(($3::timestamptz - interval '10 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000000000Z"'),
          $4,$5,$5,NULL,'unclassified',false,200,'unpriced','unknown')`,
        [earlier, home, at, pool, person, await digest("fixture-unidentified")],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_starts (request_id,pool,person,client_key,endpoint,started_at)
        VALUES (md5('earlier')::uuid,$1,$2,$2,'/v1/responses',$3::timestamptz - interval '25 hours')`,
        [pool, person, at],
      );
      await db.query(
        `INSERT INTO basalt_model_terminal_finishes (request_id,outcome,status,bytes,finished_at)
        VALUES (md5('earlier')::uuid,'truncated',502,1,$1::timestamptz - interval '23 hours')`,
        [at],
      );
      await db.query("ANALYZE");

      let statement: { text: string; values?: unknown[] } | undefined;
      const recorded: HistoryDatabase = {
        query: (text, values) => {
          if (text.includes("FROM selected")) statement = { text, values };
          return db.query(text, values);
        },
      };
      const [hour, day, current] = await readPoolReliabilityWindows(
        recorded,
        "fixture",
        [3_600_000, 86_400_000, 300_000].map((duration) => ({
          from: new Date(now - duration).toISOString(),
          to: at,
        })),
        true,
      );
      // A request counts at its terminal finish, one second after its Home row.
      assert.deepEqual(
        [hour, day, current].map((window) => [window!.real.requests, window!.real.failed]),
        [
          [121, 1],
          [dayRows + 2, 28 + 1],
          [10, 0],
        ],
      );

      assert.ok(statement);
      const explained = await db.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
        statement.values,
      );
      const plan = (explained.rows[0]?.["QUERY PLAN"] as { Plan: PlanNode }[])[0]!.Plan;
      const { into: read, indexes } = rowsRead(plan);
      console.log("reliability window read", Object.fromEntries(read), [...indexes].sort());
      const history = historyRows + importedRows + dayRows;
      // The old OR shape examined every pool row at least once: over 142,000 here.
      assert.ok(
        (read.get("basalt_model_requests") ?? 0) < 5 * dayRows,
        `request rows examined: ${read.get("basalt_model_requests")} of ${history}`,
      );
      // A nested scan of a CTE per row would grow with the square of the window.
      for (const [table, count] of read)
        if (table.startsWith("cte "))
          assert.ok(count < 5 * dayRows, `${table} rows scanned: ${count}`);
      // Terminal evidence may be hashed whole, but never rescanned per partition or per row: the old
      // shape read every start once per request partition, over 360,000 rows here.
      for (const table of ["basalt_model_terminal_starts", "basalt_model_terminal_finishes"])
        assert.ok(
          (read.get(table) ?? 0) <= 4 * (dayRows + oldTerminals + 1),
          `${table} rows examined: ${read.get(table)} of ${dayRows + oldTerminals + 1}`,
        );
    } finally {
      await database.close();
    }
  },
);
