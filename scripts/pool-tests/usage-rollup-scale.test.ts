import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary, summarySessionSettings } from "../../src/pool/model-history/summary.ts";
import {
  planUsageRollup,
  runUsageRollup,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const rows = Number(process.env.POOL_TEST_ROLLUP_ROWS ?? 3_000_000);
const prices: readonly OverviewApiPrice[] = [
  ...summaryPrices,
  { ...summaryPrices[1]!, minInput: "200001", input: "20", output: "60", cacheRead: "4" },
];
const to = "2026-03-31T13:37:12.000000123Z";
const window = Date.parse("2026-03-31T13:37:12Z") - Date.parse("2026-01-01T00:00:00Z");

/** `count` requests spread over the window from `offset`, in every shape the summary separates. */
/**
 * Context input per request. The default is production's shape: mostly short requests, one in
 * fifty long-context. POOL_TEST_ROLLUP_SHAPE=worst varies every key, and every price band, per
 * request: the grouping worst case, which the summary must refuse over its group bound.
 */
const worst = process.env.POOL_TEST_ROLLUP_SHAPE === "worst";
const input = worst
  ? "1000+n%250000"
  : "(CASE WHEN n%50=0 THEN 200001+n%60000 ELSE 1000+n%30000 END)";
/**
 * Which caller a request comes from. Production's requests come from a few accounts, apps and
 * models whose shape travels together; the worst case varies every key independently.
 */
const profile = worst ? "n" : "n%8";

const generated = (
  poolId: string,
  sources: { home: string; gateway: string; imported: string },
  accounts: { visible: string; hidden: string },
  offset: number,
  count: number,
) => ({
  text: `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,
      account,attribution,provider,model,api_type,input_tokens,output_tokens,cache_read_tokens,
      cache_write_tokens,reasoning_tokens,total_tokens,token_quality,failed,status_code,cost,currency,
      cost_basis)
    SELECT encode(sha256(convert_to('scale-id-'||n,'UTF8')),'hex'),src,
      encode(sha256(convert_to('scale-record-'||n,'UTF8')),'hex'),at,
      to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z',$1,
      CASE WHEN src=$3 THEN NULL WHEN src=$4 THEN 'i:'||repeat('e',62)
        WHEN k%7=0 THEN $6 ELSE $5 END,
      CASE WHEN src=$4 THEN 'import-owner' WHEN k%3=0 THEN 'charge-snapshot' ELSE 'key-at-capture' END,
      'fixture-lab',CASE WHEN k%23=0 THEN NULL ELSE 'fixture-model-'||(k%2) END,
      CASE k%4 WHEN 0 THEN 'responses' WHEN 1 THEN 'messages' WHEN 2 THEN NULL ELSE 'chat-completions' END,
      ${input},n%500,n%300,n%50,n%30,${input}+n%500,
      CASE k%13 WHEN 0 THEN 'legacy' WHEN 1 THEN 'unclassified' ELSE 'complete' END,
      src=$3 OR n%17=0,CASE WHEN src=$3 THEN 503 WHEN n%17=0 THEN CASE WHEN n%2=0 THEN 429 ELSE 500 END END,
      CASE WHEN src=$4 THEN 0.001*(n%10) WHEN k%5=0 THEN 0.002*(n%9) END,
      CASE WHEN src=$4 OR k%5=0 THEN 'USD' END,
      CASE WHEN src=$4 THEN 'historical-api-price' WHEN k%5=0 THEN 'home-charge' ELSE 'unpriced' END
    FROM generate_series($7::int,$8::int) n
    CROSS JOIN LATERAL (SELECT ${profile} AS k) p
    CROSS JOIN LATERAL (SELECT CASE k%10 WHEN 0 THEN $3 WHEN 1 THEN $4 ELSE $2 END AS src,
      '2026-01-01T00:00:00Z'::timestamptz + ((n % $9)::double precision/$9 * $10) * interval '1 millisecond' AS at) g`,
  values: [
    poolId,
    sources.home,
    sources.gateway,
    sources.imported,
    accounts.visible,
    accounts.hidden,
    offset + 1,
    offset + count,
    rows,
    window,
  ],
});

test(`a pool with ${rows} history rows backfilled in interrupted runs, with writers racing it, reads the same summary from the rollup as from raw rows`, async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const poolId = (await digest(pool)).slice(0, 16);
    const sources = {
      home: fixture.source,
      gateway: await digest("pool-gateway-v1"),
      imported: await digest("fixture-import"),
    };
    const accounts = { visible: fixture.visible, hidden: fixture.hidden };
    // History written before the rollup's trigger existed, as production's is.
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    for (let offset = 0; offset < rows; offset += 500_000) {
      const query = generated(poolId, sources, accounts, offset, Math.min(500_000, rows - offset));
      await f.db.query(query.text, query.values);
    }
    await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER basalt_model_usage_rollup");
    await f.db.query("ANALYZE basalt_model_requests");

    const planned = await planUsageRollup(f.db);
    const walBefore = String(
      (await f.db.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0]!.lsn,
    );
    assert.equal(planned.plan.pools.length, 1);
    // A backfill stopped by its budget, then resumed by later runs, while a writer races it.
    const writer = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await writer.connect();
    let runs = 0,
      groups = 0;
    try {
      await writer.query(`SET search_path TO ${f.schema}`);
      // The writers' own lock timeout: a backfill that held the pool longer fails this writer.
      await writer.query("SET lock_timeout = '500ms'");
      let slowestWrite = 0;
      let extra = rows;
      // POOL_TEST_ROLLUP_RACE=0 measures the backfill's own write-ahead log, with no writer.
      let racing = process.env.POOL_TEST_ROLLUP_RACE !== "0";
      const race = (async () => {
        while (racing) {
          const query = generated(poolId, sources, accounts, extra, 50);
          extra += 50;
          const started = performance.now();
          await writer.query(query.text, query.values);
          slowestWrite = Math.max(slowestWrite, performance.now() - started);
        }
      })();
      const backfillStarted = performance.now();
      let hours = 0,
        backfillWal = 0;
      for (;;) {
        runs++;
        const result = await runUsageRollup(f.db, planned.plan, 1_500);
        groups += result.pools.reduce((n, item) => n + item.groups, 0);
        hours += result.pools.reduce((n, item) => n + item.recomputedHours, 0);
        backfillWal = Math.max(backfillWal, result.walBytes);
        assert.ok(
          result.walBytes <= 40 * 1024 * 1024,
          `one call wrote ${result.walBytes} WAL bytes`,
        );
        if (result.status === "complete") break;
      }
      console.info(
        "ROLLUP_BACKFILL",
        JSON.stringify({
          hours,
          runs,
          ms: Math.round(performance.now() - backfillStarted),
          largestCallWal: backfillWal,
          race: process.env.POOL_TEST_ROLLUP_RACE !== "0",
        }),
      );
      racing = false;
      await race;
      console.info("ROLLUP_WRITER", JSON.stringify({ slowestWriteMs: Math.round(slowestWrite) }));
    } finally {
      await writer.end();
    }
    assert.ok(runs > 1, "the backfill stopped and resumed");
    const measured = (
      await f.db.query(
        `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::bigint AS wal,
          pg_total_relation_size('basalt_model_usage_hourly') AS rollup,
          pg_total_relation_size('basalt_model_usage_hours') AS hours,
          (SELECT sum(pg_total_relation_size(c.oid)) FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
            WHERE i.inhparent='basalt_model_requests'::regclass) AS history`,
        [walBefore],
      )
    ).rows[0]!;
    // The racing writer's own inserts are in this WAL too; the backfill's share is below it.
    console.info("ROLLUP_BYTES", JSON.stringify(measured));
    // Bounded by the data's shape, not its size: groups, their bytes and the backfill's WAL.
    assert.ok(groups <= rows / 5, `${groups} groups for ${rows} rows`);
    assert.ok(Number(measured.rollup) <= groups * 1_500, `${measured.rollup} rollup bytes`);
    assert.ok(Number(measured.wal) <= Number(measured.history), `${measured.wal} WAL bytes`);

    const input = {
      pool,
      from: "2026-03-24T23:00:00Z",
      to,
      by: "model" as const,
      authority: fixture.authority,
    };
    const statements: { text: string; values?: unknown[]; ms: number }[] = [];
    const timed: HistoryDatabase = {
      query: async (text, values) => {
        const started = performance.now();
        try {
          return await f.db.query(text, values);
        } finally {
          statements.push({ text, values, ms: performance.now() - started });
        }
      },
    };
    const groupRows = (
      await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_hourly WHERE pool=$1", [
        poolId,
      ])
    ).rows[0]!.n as number;
    console.info("ROLLUP_GROUPS", JSON.stringify({ rows, runs, groups, groupRows }));
    if (process.env.POOL_TEST_ROLLUP_SHAPE === "worst") {
      // Past the group bound the summary refuses fast instead of reading every group.
      await assert.rejects(
        poolUsageSummary(timed, input, async () => ({ prices, issues: [] }), Date.parse(to)),
        /too large to summarize/,
      );
      return;
    }
    const rolled = await poolUsageSummary(
      timed,
      input,
      async () => ({ prices, issues: [] }),
      Date.parse(to),
    ).catch((error: unknown) => {
      console.info(
        "ROLLUP_READ_FAILED",
        JSON.stringify(statements.map(({ text, ms }) => [text.slice(0, 40), Math.round(ms)])),
      );
      throw error;
    });
    console.info(
      "ROLLUP_READ",
      JSON.stringify(statements.map(({ text, ms }) => [text.slice(0, 40), Math.round(ms)])),
    );
    if (process.env.POOL_TEST_ROLLUP_EXPLAIN) {
      await f.db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      for (const { text, values, ms } of statements)
        if (ms > 200 && /^\s*WITH/.test(text)) {
          const plan = await f.db.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
          console.info(
            "ROLLUP_PLAN",
            Math.round(ms),
            "\n" + plan.rows.map((r) => r["QUERY PLAN"]).join("\n"),
          );
        }
      await f.db.query("ROLLBACK");
    }
    // The coverage statement names the rollup only on the rollup path.
    assert.ok(
      statements[3]!.text.includes("basalt_model_usage_hourly"),
      "the read used the rollup",
    );
    assert.ok(statements.length <= 15, `${statements.length} statements`);
    const rollupMs = statements.reduce((n, { ms }) => n + ms, 0);
    assert.ok(
      statements.every(({ ms }) => ms < 4_000),
      "every rollup statement answers well inside its 5 s limit",
    );
    const rollupRows = (
      await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_hourly WHERE pool=$1", [
        poolId,
      ])
    ).rows[0]!.n as number;

    // The same read from raw rows, without the ready marker and without the window bound.
    await f.db.query("DELETE FROM basalt_model_usage_ready");
    // The raw truth cannot answer inside 5 s at this size; only this comparison read may take longer.
    const patient: HistoryDatabase = {
      query: (text, values) =>
        f.db.query(
          text === summarySessionSettings ? summarySessionSettings.replace("'5s'", "'600s'") : text,
          values,
        ),
    };
    const raw = await poolUsageSummary(
      patient,
      input,
      async () => ({ prices, issues: [] }),
      Date.parse(to),
      undefined,
      Number.MAX_SAFE_INTEGER - 1,
    );
    const data = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (key, field) =>
          key === "capturedAt" || key === "asOf" ? "read time" : field,
        ),
      );
    assert.deepEqual(data(rolled), data(raw));
    console.info(
      "ROLLUP_SCALE",
      JSON.stringify({ rows, runs, groups, rollupRows, rollupMs: Math.round(rollupMs) }),
    );
  });
});
