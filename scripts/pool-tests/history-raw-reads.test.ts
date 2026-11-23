import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { callerHeader } from "../../apps/pool/contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { handleModelHistory } from "../../src/pool/model-history/http.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { readRequests } from "../../src/pool/model-history/store.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];

/**
 * Production's shape, at a size where reading the whole pool is plain in the plan: one pool's
 * history all from the native source, the Home usage rows of its newest requests, and a capture
 * cursor on the newest one. Plans are asserted, not times: a whole-pool read that takes 10 s on a
 * small instance takes well under a second here.
 */
const rows = 20_000;
const native = 40;
const first = "2026-05-05T11:00:00Z",
  last = "2026-11-23T19:00:00Z";

async function history(f: Fixture) {
  const fixture = await summaryFixture(f);
  const poolId = (await digest(pool)).slice(0, 16);
  await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER USER");
  await f.db.query(
    `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,account,
      provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,
      token_quality,failed,status_code,cost_basis,ingested_at,attribution)
    SELECT encode(sha256(convert_to('raw-read-'||n,'UTF8')),'hex'), $1,
      encode(sha256(convert_to('["usage","'||n||'"]','UTF8')),'hex'), at,
      to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z', $2, $3,
      'fixture-lab', 'fixture-model-'||(n%3), 1000, 10, 0, 0, 1010, 'complete', false, 200,
      'unpriced', at, 'key-at-capture'
    FROM generate_series(1,$4::int) n
    CROSS JOIN LATERAL (SELECT $5::timestamptz + (n::float/$4::int) * ($6::timestamptz - $5::timestamptz) AS at) x`,
    [fixture.source, poolId, fixture.visible, rows, first, last],
  );
  await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER USER");
  await f.db.query(
    `INSERT INTO usage (id,timestamp,api_key)
    SELECT n, $2::timestamptz + (n::float/$1::int) * ($3::timestamptz - $2::timestamptz), $4
    FROM generate_series($1::int-$5::int+1,$1::int) n`,
    [rows, first, last, fixture.fingerprint, native],
  );
  await fixture.cursor(rows);
  await fixture.analyze();
  return { fixture, poolId };
}

/** Statements in the order they ran, with the step the read had marked. */
function recording(db: HistoryDatabase) {
  const seen: { step: string; text: string; values?: unknown[] }[] = [];
  let step = "";
  return {
    seen,
    mark: (next: string) => {
      step = next;
    },
    db: {
      query: (text: string, values?: unknown[]) => {
        seen.push({ step, text, values });
        return db.query(text, values);
      },
    } satisfies HistoryDatabase,
  };
}

/** What a statement did to the request table: rows read, rows a filter dropped, and how. */
async function plan(db: HistoryDatabase, text: string, values?: unknown[]) {
  const found = {
    read: 0,
    removed: 0,
    seqScan: false,
    sortOverScan: false,
    indexes: new Set<string>(),
  };
  const walk = (node: Record<string, unknown>, underSort: boolean) => {
    const type = String(node["Node Type"]);
    const relation = String(node["Relation Name"] ?? "");
    if (relation.startsWith("basalt_model_requests")) {
      const loops = Number(node["Actual Loops"] ?? 1);
      const removed = Number(node["Rows Removed by Filter"] ?? 0) * loops;
      found.read += Number(node["Actual Rows"] ?? 0) * loops + removed;
      found.removed += removed;
      if (type === "Seq Scan") found.seqScan = true;
      if (underSort && /Scan/.test(type)) found.sortOverScan = true;
      if (node["Index Name"]) found.indexes.add(String(node["Index Name"]).replace(/_\d+_/, "_"));
    }
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
      walk(child, underSort || type === "Sort");
  };
  const explained = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values);
  walk((explained.rows[0]!["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]!.Plan, false);
  return found;
}

test("the request history reads each page through the pool's time index, never the whole pool", async () => {
  await seriesFixture(async (f) => {
    const { poolId } = await history(f);
    const read = recording(f.db);
    const query = { pool: poolId, from: "1970-01-01T00:00:00.000Z", to: last };
    const page = await readRequests(read.db, query);
    assert.equal(page.records.length, 200);
    await readRequests(read.db, { ...query, after: page.next! });
    const pages = read.seen.filter((entry) => entry.text.includes("page_timestamp"));
    assert.equal(pages.length, 2);
    for (const entry of pages) {
      const found = await plan(f.db, entry.text, entry.values);
      // A merge of the 16 partitions' index scans: the page and at most one row ahead in each.
      assert.equal(found.seqScan, false, "no partition is scanned whole");
      assert.equal(found.sortOverScan, false, "the index gives the order; nothing is sorted");
      assert.ok(found.read <= 201 + 16, `a page read ${found.read} request rows`);
      assert.deepEqual([...found.indexes], ["basalt_model_requests_pool_timestamp_id_idx"]);
    }
  });
});

test("the request history's pages follow their own cursor when requests share a microsecond", async () => {
  await seriesFixture(async (f) => {
    const { fixture, poolId } = await history(f);
    // 250 requests in one microsecond whose exact times run against their ids, so ordering by
    // the exact time and paging by (timestamp, id) would disagree.
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER USER");
    await f.db.query(
      `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,
        provider,model,token_quality,failed,cost_basis,ingested_at,attribution)
      SELECT id, $1, encode(sha256(convert_to('tie-record-'||id,'UTF8')),'hex'),
        '2026-01-01T00:00:00.000001Z', '2026-01-01T00:00:00.000001'||lpad((999-rank)::text,3,'0')||'Z',
        $2, 'fixture-lab', 'fixture-model', 'complete', false, 'unpriced', now(), 'key-at-capture'
      FROM (SELECT id, (row_number() OVER (ORDER BY id))::int AS rank FROM (
        SELECT encode(sha256(convert_to('tie-'||n,'UTF8')),'hex') AS id FROM generate_series(1,250) n) ids) ranked`,
      [fixture.source, poolId],
    );
    await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER USER");
    const query = { pool: poolId, from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:00:01Z" };
    const seen: string[] = [];
    let after: { timestamp: string; id: string } | undefined;
    for (let page = 0; page < 5; page++) {
      const read = await readRequests(f.db, { ...query, ...(after ? { after } : {}) });
      seen.push(...read.records.map((row) => String(row.id)));
      if (!read.next) break;
      after = read.next;
    }
    assert.equal(new Set(seen).size, seen.length, "no request appears twice");
    assert.equal(seen.length, 250, "no request is skipped");
    assert.deepEqual(seen, [...seen].sort(), "pages run in (timestamp, id) order");
  });
});

test("the summary finds the capture cursor's request, and the captured Home usage, by record through the index", async () => {
  await seriesFixture(async (f) => {
    const { fixture } = await history(f);
    const read = recording(f.db);
    const to = "2026-11-23T20:00:00Z";
    await poolUsageSummary(
      read.db,
      { pool, from: "2026-10-24T20:00:00Z", to, by: "model", authority: fixture.authority },
      async () => ({ prices: summaryPrices, issues: [] }),
      Date.parse(to),
      read.mark,
    );
    const state = read.seen.find(
      (entry) => entry.step === "coverage" && entry.text.includes("basalt_model_history_cursor"),
    );
    const capture = read.seen.find(
      (entry) => entry.step === "capture" && entry.text.includes("FROM usage u"),
    );
    assert.ok(state && capture, "the summary ran its capture state and capture coverage");
    for (const [name, entry] of [
      ["capture state", state],
      ["capture coverage", capture],
    ] as const) {
      const found = await plan(f.db, entry.text, entry.values);
      // The record is an index condition: no request of the native source is read and dropped.
      assert.equal(found.removed, 0, `${name} filtered ${found.removed} request rows`);
      assert.equal(found.seqScan, false, `${name} scans no partition whole`);
      assert.ok(found.read <= native + 16, `${name} read ${found.read} request rows`);
    }
  });
});

test("a history read Postgres cancels answers 503 and logs one closed POOL_USAGE_READ_FAILED line naming its step", async () => {
  await seriesFixture(async (f) => {
    await history(f);
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${f.schema}`);
    const signingKey = "ef".repeat(32);
    const token = await signPoolToken(signingKey, {
      pool,
      owner: "fixture-manager",
      organization: "fixture-organization",
    });
    // A writer holding the table keeps the page's statement waiting until Postgres cancels it.
    const holder = new pg.Client({ connectionString: url.toString() });
    await holder.connect();
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...line: unknown[]) => void logged.push(line);
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE basalt_model_requests IN ACCESS EXCLUSIVE MODE");
      const response = await handleModelHistory(
        new Request(
          `https://pool.example.test/pool/v1/usage/history?${new URLSearchParams({ from: first, to: last })}`,
          { headers: { authorization: `Bearer ${token}`, [callerHeader]: "fixture-manager" } },
        ),
        {
          signingKey,
          connectionString: url.toString(),
          permissions: async () => ({ canUse: true, canManage: true }),
        },
      );
      assert.equal(response.status, 503);
    } finally {
      console.error = original;
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
    const lines = logged.filter((line) => line[0] === "POOL_USAGE_READ_FAILED");
    assert.equal(lines.length, 1);
    const fields = JSON.parse(String(lines[0]![1]));
    assert.equal(fields.action, "poolUsageHistory");
    assert.equal(fields.status, 503);
    assert.equal(
      fields.sqlstate,
      "57014",
      "Postgres itself cancelled it, before the driver gave up",
    );
    assert.equal(fields.step, "page");
    // Closed fields only: no SQL, no message from the database, no caller data.
    assert.deepEqual(
      Object.keys(fields).filter(
        (key) =>
          ![
            "action",
            "status",
            "failure",
            "elapsedMs",
            "sqlstate",
            "statement",
            "statementMs",
            "step",
          ].includes(key),
      ),
      [],
    );
    assert.ok(fields.elapsedMs < 6_000, `cancelled after ${fields.elapsedMs} ms`);
  });
});
