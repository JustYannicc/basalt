import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { homeCaptureCoverage } from "../../src/pool/model-history/capture-coverage.ts";
import {
  countCaptureHour,
  countBlockStatement,
  countCaptureBlock,
} from "../../src/pool/model-history/capture-hours-count.ts";
import {
  captureHoursLookbackHours,
  planCaptureHours,
  pruneCaptureHours,
} from "../../src/pool/model-history/capture-hours-plan.ts";
import { poolUsernamePattern } from "../../src/pool/model-history/capture-population.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  at,
  captureFixture,
  fillByTicks,
  hourKey,
  lookbackHours,
  recording,
} from "./capture-hours-fixture.ts";
import { summaryPrices } from "./usage-summary-fixture.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import {
  captureHoursLockClass,
  historyCaptureHoursVersion,
} from "../../src/pool/model-history/capture-hours-schema.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

const lots = () => 60_000;
/** A block's start, as the plan writes it, and its missing hours. */
const blockOf = (block: { from: string; missing?: number }) => [
  new Date(Date.parse(block.from)).toISOString(),
  block.missing,
];
/** The start of the six-hour block an hour belongs to. */
const blockStart = (hour: string) =>
  new Date(Math.floor(Date.parse(hour) / (6 * 3_600_000)) * 6 * 3_600_000).toISOString();
type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
/** The per-row check's ranges as [from, to] instants, or undefined when it did not run. */
const spans = (ranges: readonly { f: string; t: string }[] | undefined) =>
  ranges?.map((range) => [
    new Date(Date.parse(range.f)).toISOString(),
    new Date(Date.parse(range.t)).toISOString(),
  ]);

test("an hour whose stored count equals its captured requests reads complete without a per-row check", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 600_000));
    await c.native(at(0, 1_200_000));
    await c.native(at(5, 60_000));
    await c.ready();
    await c.fill();
    assert.equal((await c.stored())[hourKey(0)], 2);
    const read = await c.coverage(at(0), at(24));
    assert.deepEqual([...read.incomplete!], []);
    assert.equal(read.ranges, undefined, "no usage row of the window was read row by row");
  });
});

test("a usage row without its request makes the counts differ, and its hour is checked row by row and incomplete", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.native(at(7, 60_000));
    await c.usage(at(7, 180_000));
    await c.ready();
    await c.fill();
    const read = await c.coverage(at(0), at(24));
    assert.deepEqual(read.ranges, [
      { f: at(7).replace("Z", "000Z"), t: at(8).replace("Z", "000Z") },
    ]);
    assert.deepEqual([...read.incomplete!], [hourKey(7)]);
  });
});

test("a deleted usage row makes the counts differ, and the per-row check reads its hour complete", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.native(at(3, 60_000));
    await c.native(at(3, 120_000));
    await c.ready();
    await c.fill();
    await f.db.query("DELETE FROM usage WHERE timestamp=$1", [at(3, 120_000)]);
    assert.equal((await countCaptureHour(f.db, c.poolId, at(3), lots)).kind, "done");
    assert.equal((await c.stored())[hourKey(3)], 1);
    const read = await c.coverage(at(0), at(24));
    assert.deepEqual(read.ranges, [
      { f: at(3).replace("Z", "000Z"), t: at(4).replace("Z", "000Z") },
    ]);
    assert.deepEqual([...read.incomplete!], []);
  });
});

test("hours the tick never counted are read row by row, as before v17, as one range", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.native(at(30, 60_000));
    // A missing request inside the uncounted day: only the per-row check can find it.
    await c.usage(at(10, 60_000));
    await c.ready();
    await c.fill();
    // As if the tick had stopped for that day: its counts are gone.
    await f.db.query("DELETE FROM basalt_model_capture_hours WHERE hour >= $1 AND hour < $2", [
      at(4),
      at(28),
    ]);
    const read = await c.coverage(at(0), at(36));
    assert.deepEqual(
      [...read.incomplete!],
      [hourKey(10)],
      "the row check found the missing request",
    );
    assert.deepEqual(spans(read.ranges), [[at(4), at(28)]], "the uncounted day, as one range");
  });
});

test("a count taken before its hour settled is uncounted: read row by row by the summary and pending for the tick", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.native(at(2, 60_000));
    await c.ready();
    await c.fill();
    await f.db.query(
      "UPDATE basalt_model_capture_hours SET checked_at=hour + interval '1 hour 59 minutes' WHERE hour=$1",
      [at(2)],
    );
    const read = await c.coverage(at(0), at(24));
    assert.deepEqual([...read.incomplete!], []);
    assert.deepEqual(spans(read.ranges), [[at(2), at(3)]], "that hour, and only it, row by row");
    const plan = await planCaptureHours(f.db, lookbackHours);
    // The block holding that hour is pending, missing that one hour.
    assert.deepEqual(
      plan?.pools.map((item) => [item.pool, item.pendingBlocks, item.pendingHours]),
      [[c.poolId, 1, 1]],
    );
    assert.deepEqual(blockOf(plan!.pools[0]!.blocks[0]!), [blockStart(at(2)), 1]);
    await c.fill();
    const recounted = await c.coverage(at(0), at(24));
    assert.deepEqual([...recounted.incomplete!], []);
    assert.equal(recounted.ranges, undefined, "counted again, nothing is read row by row");
  });
});

test("the tail since the settle horizon and the hours a bound cuts are always checked row by row", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.ready();
    await c.fill();
    const horizon = (
      await f.db.query(
        `SELECT to_char(date_trunc('hour',now() - interval '2 hours','UTC') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
      )
    ).rows[0]!.at as string;
    // Missing requests in the hour cut by the window's start and in the tail.
    await c.usage(at(1, 2_400_000));
    await c.usage(new Date(Date.now() - 1_800_000).toISOString());
    const from = at(1, 1_800_000);
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const read = await c.coverage(from, to);
    assert.deepEqual(read.ranges, [
      { f: from.replace("Z", "000Z"), t: at(2).replace("Z", "000Z") },
      { f: horizon, t: to.replace("Z", "000Z") },
    ]);
    const tail = new Date(Date.now() - 1_800_000);
    tail.setUTCMinutes(0, 0, 0);
    assert.deepEqual([...read.incomplete!].sort(), [
      hourKey(1),
      tail.toISOString().replace(".000Z", "Z"),
    ]);
    // A window inside one hour has no whole hour: it is read row by row, all of it.
    const inside = await c.coverage(at(1, 60_000), at(1, 3_000_000));
    assert.deepEqual(inside.ranges, [
      { f: at(1, 60_000).replace("Z", "000Z"), t: at(1, 3_000_000).replace("Z", "000Z") },
    ]);
    assert.deepEqual([...inside.incomplete!], [hourKey(1)]);
  });
});

test("rows at the last microsecond of an hour and the first of the next land in the same hours on both sides", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    const before = new Date(Date.parse(at(11)) - 1).toISOString().replace(/\.\d{3}Z$/, ".999999Z");
    const after = at(11).replace(".000Z", ".000000Z");
    await c.native(at(0, 60_000));
    await c.native(before);
    await c.native(after);
    await c.ready();
    await c.fill();
    const stored = await c.stored();
    assert.deepEqual([stored[hourKey(10)], stored[hourKey(11)]], [1, 1], "the counts");
    const rolled = Object.fromEntries(
      (
        await f.db.query(
          `SELECT to_char(hour AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour,
            sum(requests)::int AS n FROM basalt_model_usage_people_hourly
          WHERE pool=$1 AND source=$2 GROUP BY 1`,
          [c.poolId, c.source],
        )
      ).rows.map((row) => [String(row.hour), Number(row.n)]),
    );
    assert.deepEqual([rolled[hourKey(10)], rolled[hourKey(11)]], [1, 1], "the rollup");
    const read = await c.coverage(at(0), at(24));
    assert.deepEqual([...read.incomplete!], []);
    assert.equal(read.ranges, undefined);
  });
});

test("an hour's count is exactly the usage rows the per-row check considers", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    const charged = async (time: string) => {
      const id = await c.usage(time, "not-a-key");
      await f.db.query("INSERT INTO billing_charge (id,usage_id,user_id) VALUES ($1,$2,7)", [
        String(id),
        id,
      ]);
    };
    await f.db.query(
      "INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES (11,'raw-key',7)",
    );
    // One case an hour: [hour, expected count].
    const cases: [number, number][] = [];
    await c.usage(at(1, 60_000));
    cases.push([1, 1]); // the pool's user by key
    await charged(at(2, 60_000));
    cases.push([2, 1]); // the pool's user by charge
    await c.usage(at(3, 60_000), c.otherKey);
    cases.push([3, 0]); // another pool's user
    await c.usage(at(4, 60_000), "raw-key");
    cases.push([4, 0]); // a key that is no fingerprint never matches
    for (let n = 0; n < 60; n++) await c.native(at(5, n * 1_000));
    for (let n = 0; n < 4; n++) await c.native(at(5, 100_000 + n * 1_000), true);
    cases.push([5, 60]); // probe-like rows of the pool's user, captured, beside another pool's
    for (let n = 0; n < 3; n++) await c.usage(at(6, n * 1_000));
    for (let n = 0; n < 2; n++) await c.usage(at(6, 10_000 + n * 1_000), c.otherKey);
    await charged(at(6, 20_000));
    cases.push([6, 4]);
    for (const [hour] of cases)
      assert.equal((await countCaptureHour(f.db, c.poolId, at(hour), lots)).kind, "done");
    const stored = await c.stored();
    assert.deepEqual(
      cases.map(([hour]) => stored[hourKey(hour)]),
      cases.map(([, count]) => count),
    );
    // The rollup side holds the pool's own requests of that hour, never the other pool's.
    const rolled = await f.db.query(
      `SELECT pool, sum(requests)::int AS n FROM basalt_model_usage_people_hourly
      WHERE hour=$1 AND source=$2 GROUP BY pool ORDER BY pool`,
      [at(5), c.source],
    );
    assert.deepEqual(Object.fromEntries(rolled.rows.map((row) => [row.pool, row.n])), {
      [c.poolId]: 60,
      [c.otherId]: 4,
    });
    // Against a source with no request at all, the per-row check finds every row it considers.
    const nowhere = await digest("no-such-source");
    const considered = await homeCaptureCoverage(f.db, c.poolId, nowhere, at(1), at(7));
    assert.deepEqual(
      [...considered.incompleteHours!].sort(),
      cases.filter(([, count]) => count > 0).map(([hour]) => hourKey(hour)),
    );
    // The other pool's count is its own user's rows alone.
    assert.equal((await countCaptureHour(f.db, c.otherId, at(6), lots)).kind, "done");
    assert.deepEqual(await c.stored(c.otherId), { [hourKey(6)]: 2 });
  });
});

/** Rows each relation's scans read, and the indexes they used. */
async function shape(db: HistoryDatabase, text: string, values?: unknown[]) {
  const reads: Record<string, number> = {};
  const indexes = new Set<string>();
  const seq = new Set<string>();
  const walk = (node: Record<string, unknown>) => {
    const relation = node["Relation Name"];
    if (typeof relation === "string") {
      const loops = Number(node["Actual Loops"] ?? 1);
      const name = relation.replace(/_\d+$/, "");
      reads[name] =
        (reads[name] ?? 0) +
        (Number(node["Actual Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0)) * loops;
      if (node["Index Name"]) indexes.add(String(node["Index Name"]));
      if (node["Node Type"] === "Seq Scan") seq.add(name);
    }
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  await db.query("BEGIN");
  try {
    const explained = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values);
    walk((explained.rows[0]!["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]!.Plan);
  } finally {
    await db.query("ROLLBACK");
  }
  return { reads, indexes, seq };
}

test("plans: a count reads one hour of usage through its time index, and the summary's capture never reads the window's usage", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    // Forty hours of Home usage, 50 rows an hour, all captured, ending before the settle horizon.
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER USER");
    await f.db.query(
      `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,
        provider,model,token_quality,failed,cost_basis,ingested_at,attribution)
      SELECT encode(sha256(convert_to('["'||$1::text||'","'||r||'"]','UTF8')),'hex'), $1, r, t,
        to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z', $2, 'fixture-lab',
        'fixture-model', 'complete', false, 'unpriced', t, 'key-at-capture'
      FROM generate_series(1,2000) n
      CROSS JOIN LATERAL (SELECT encode(sha256(convert_to('["usage","'||n||'"]','UTF8')),'hex') AS r,
        $3::timestamptz + (n - 1) * interval '72 seconds' AS t) x`,
      [c.source, c.poolId, at(0)],
    );
    await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER USER");
    await f.db.query(
      `INSERT INTO usage (id,timestamp,api_key)
      SELECT n, $1::timestamptz + (n - 1) * interval '72 seconds', $2 FROM generate_series(1,2000) n`,
      [at(0), c.fingerprint],
    );
    await c.ready();
    await c.fill();
    await c.analyze();
    // A block reads its six hours of usage, 300 rows, and an hour's block its one hour.
    for (const [hours, rows] of [
      [6, 300],
      [1, 50],
    ] as const) {
      const count = await shape(f.db, countBlockStatement, [
        c.poolId,
        at(12),
        at(12 + hours),
        poolUsernamePattern(c.poolId),
        c.source,
      ]);
      assert.equal(count.reads.usage, rows, `${hours} hours' usage rows`);
      assert.ok(count.indexes.has("fixture_usage_time"), [...count.indexes].join(" "));
      assert.ok(!count.seq.has("usage"), "no scan of all usage");
    }
    const read = recording(f.db);
    await f.db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await homeCaptureCoverage(
      read.db,
      c.poolId,
      c.source,
      at(0, 1_800_000),
      new Date().toISOString(),
      true,
    );
    await f.db.query("ROLLBACK");
    const control = (text: string) =>
      /^(SAVEPOINT|ROLLBACK TO|RELEASE|SELECT set_config)/.test(text);
    assert.deepEqual(
      read.seen.filter((entry) => control(entry.text)).map((entry) => entry.text.split(" ")[0]),
      ["SAVEPOINT", "SELECT", "ROLLBACK", "RELEASE"],
      "the row check runs in its own savepoint under its own limit",
    );
    const capture = read.seen.filter(
      (entry) => !entry.text.includes("to_regclass('usage')") && !control(entry.text),
    );
    assert.equal(capture.length, 2, "two statements: the stored hours and the rows they leave");
    let usage = 0,
      probes = 0;
    for (const entry of capture) {
      const found = await shape(f.db, entry.text, entry.values);
      usage += found.reads.usage ?? 0;
      probes += found.reads.basalt_model_requests ?? 0;
      assert.ok(!found.seq.has("usage"), "no scan of all usage");
    }
    // The half hour the window's start cuts, and nothing else: the tail since the horizon is empty.
    // A scan's rows are reported per loop, rounded, so the usage side is exact to a row a range.
    assert.equal(probes, 25, "each of the cut half hour's usage rows probed its request once");
    assert.ok(usage <= 25 + 2, `the capture step read ${usage} of the window's usage rows`);
  });
});

test("without v17, or for a pool not ready on v16, the capture check reads every usage row of its window as before", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.usage(at(3, 60_000));
    const whole = (seen: { text: string }[]) =>
      seen.filter((entry) => entry.text.includes("u.timestamp < $3::timestamptz")).length;
    // Not ready on v16: the stored hours say so, and the window is read row by row.
    let read = recording(f.db);
    let result = await homeCaptureCoverage(read.db, c.poolId, c.source, at(0), at(24), true);
    assert.deepEqual([...result.incompleteHours!], [hourKey(3)]);
    assert.equal(whole(read.seen), 1);
    await c.ready();
    await c.fill();
    await f.db.query("DROP TABLE basalt_model_capture_hours");
    read = recording(f.db);
    result = await homeCaptureCoverage(read.db, c.poolId, c.source, at(0), at(24), true);
    assert.deepEqual([...result.incompleteHours!], [hourKey(3)]);
    assert.equal(whole(read.seen), 1);
    assert.equal(
      read.seen.filter((entry) => entry.text.includes("basalt_model_capture_hours s")).length,
      0,
      "no stored hour is read before v17",
    );
  });
});

/** The settle horizon as the database computes it, as an ISO time to the millisecond. */
async function horizon(db: HistoryDatabase) {
  const row = await db.query("SELECT date_trunc('hour',now() - interval '2 hours','UTC') AS at");
  return (row.rows[0]!.at as Date).getTime();
}

test("every pool ready on v16 is counted over the 400 days before the settle horizon, newest first", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.ready();
    const end = await horizon(f.db);
    const plan = (await planCaptureHours(f.db))!.pools;
    assert.equal(captureHoursLookbackHours, 9_600);
    // Six-hour blocks: 1,600, and one more when the horizon falls inside a block, cutting two.
    const blocks = end % (6 * 3_600_000) === 0 ? 1_600 : 1_601;
    assert.deepEqual(
      plan.map((item) => [item.pool, item.pendingHours, item.pendingBlocks, item.blocks.length]),
      [[c.poolId, 9_600, blocks, 100]],
      "400 days of hours, whatever the pool's first request, listed 100 blocks at a time",
    );
    // Newest first: the block before the horizon, then each one before it, back to back.
    const newest = Math.floor((end - 3_600_000) / (6 * 3_600_000)) * 6 * 3_600_000;
    assert.deepEqual(blockOf(plan[0]!.blocks[0]!), [
      new Date(newest).toISOString(),
      (end - newest) / 3_600_000,
    ]);
    for (let n = 1; n < plan[0]!.blocks.length; n++)
      assert.equal(
        plan[0]!.blocks[n]!.to,
        plan[0]!.blocks[n - 1]!.from,
        "newest first, back to back",
      );
  });
});

test("a pool with only imported rows is counted, and its counted hours read complete", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    const imported = await digest("fixture-import");
    for (const hour of [0, 5, 30])
      await f.insert({
        source: imported,
        attribution: "import-owner",
        account: `i:${"e".repeat(62)}`,
        timestamp: timestamp(at(hour, 60_000)),
        provider: "fixture-lab",
        model: "fixture-model-0",
      });
    await c.ready();
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_people_ready")).rows[0]!
        .n,
      1,
      "the imports-only pool is ready on v16",
    );
    await c.fill();
    const stored = await c.stored();
    assert.equal(Object.keys(stored).length, lookbackHours);
    assert.ok(
      Object.values(stored).every((n) => n === 0),
      "no Home usage: every count is 0",
    );
    const read = await c.coverage(at(0), at(36));
    assert.deepEqual([...read.incomplete!], [], "counts 0 equal the rollup's 0 Home requests");
    assert.equal(read.ranges, undefined);
  });
});

test("hours of a window older than the lookback are read row by row, as before v17", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.ready();
    await c.fill();
    const first = (await horizon(f.db)) - lookbackHours * 3_600_000;
    const before = (n: number) => new Date(first - n * 3_600_000).toISOString();
    // A missing request two hours before the lookback: only the per-row check can find it.
    await c.usage(new Date(first - 2 * 3_600_000 + 60_000).toISOString());
    const read = await c.coverage(before(4), at(24));
    assert.deepEqual([...read.incomplete!], [before(2).replace(".000Z", "Z")]);
    assert.deepEqual(
      spans(read.ranges)?.[0],
      [before(4), new Date(first).toISOString()],
      "the four hours before the lookback, as one range",
    );
  });
});

/** One hour's stored count and how many of its rows had no request. */
async function storedHour(db: HistoryDatabase, pool: string, hour: string) {
  const row = (
    await db.query(
      "SELECT usage_requests, uncaptured_requests FROM basalt_model_capture_hours WHERE pool=$1 AND hour=$2",
      [pool, hour],
    )
  ).rows[0];
  return row && { usage: Number(row.usage_requests), uncaptured: Number(row.uncaptured_requests) };
}

test("a captured hour whose every usage row has its request, with equal counts, reads complete without a row check", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(5, 60_000));
    await c.native(at(5, 120_000));
    await c.ready();
    await c.fill();
    assert.deepEqual(await storedHour(f.db, c.poolId, at(5)), { usage: 2, uncaptured: 0 });
    const read = await c.coverage(at(0), at(24));
    assert.deepEqual([...read.incomplete!], []);
    assert.equal(read.ranges, undefined);
  });
});

/**
 * Row A is captured; row M, charged to the pool's user, never was. Once `shrink` takes A out of
 * the pool's population and the hour is recounted, its count equals its captured requests, so
 * only M's own probe keeps the hour from reading complete.
 */
async function shrunk(
  f: Fixture,
  shrink: () => Promise<void>,
  /** Another of the pool's users, made once Home's tables exist; row A is on its key. */
  owner?: () => Promise<string>,
) {
  const c = await captureFixture(f);
  const key = await owner?.();
  await c.native(at(0, 60_000));
  if (key) {
    // Captured, on a key of another of the pool's users.
    const id = await c.usage(at(5, 60_000), key);
    await f.insert({
      source: c.source,
      timestamp: timestamp(at(5, 60_000)),
      sourceRecord: await digest(JSON.stringify(["usage", String(id)])),
    });
  } else await c.native(at(5, 60_000));
  const charged = await c.usage(at(5, 120_000), "not-a-key");
  await f.db.query("INSERT INTO billing_charge (id,usage_id,user_id) VALUES ($1,$2,7)", [
    String(charged),
    charged,
  ]);
  await c.ready();
  await c.fill();
  assert.deepEqual(await storedHour(f.db, c.poolId, at(5)), { usage: 2, uncaptured: 1 });
  await shrink();
  assert.equal((await countCaptureHour(f.db, c.poolId, at(5), lots)).kind, "done");
  assert.deepEqual(
    await storedHour(f.db, c.poolId, at(5)),
    { usage: 1, uncaptured: 1 },
    "the count now equals the hour's one captured request",
  );
  const read = await c.coverage(at(0), at(24));
  assert.ok(
    read.ranges?.some((range) => range.f === at(5).replace("Z", "000Z")),
    "its never-captured row sends the hour to the row check",
  );
  assert.ok(read.incomplete!.has(hourKey(5)), "and it reads incomplete");
}

test("a key rebound to another pool's user shrinks the count, and the hour's uncaptured row still reads it incomplete", async () => {
  await seriesFixture(async (f) => {
    await shrunk(f, async () => {
      await f.db.query("UPDATE api_key SET user_id=8 WHERE id=9");
    });
  });
});

test("a deleted person shrinks the count, and the hour's uncaptured row still reads it incomplete", async () => {
  await seriesFixture(async (f) => {
    await shrunk(
      f,
      async () => {
        await f.db.query('DELETE FROM "user" WHERE id=12');
      },
      async () => {
        const key = `sha256:${"c".repeat(64)}`;
        await f.db.query('INSERT INTO "user" VALUES (12,$1)', [
          await backendUserName("fixture-person-2", pool),
        ]);
        await f.db.query(
          "INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES (13,$1,12)",
          [key],
        );
        return key;
      },
    );
  });
});

test("past 800 incomplete hours the check names none, on the per-row path and the counted one", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    // Not ready on v16: the per-row path. One usage row without its request an hour.
    for (let n = 0; n < 800; n++) await c.usage(at(-800 + n, 60_000));
    const rows = await homeCaptureCoverage(f.db, c.poolId, c.source, at(-799), at(0), true);
    assert.equal(rows.incompleteHours?.size, 799);
    const over = await homeCaptureCoverage(f.db, c.poolId, c.source, at(-800), at(0), true);
    assert.equal(over.incompleteHours, null, "800 missing hours are past the bound");
    await f.db.query("DELETE FROM usage");
    // Ready and counted over the lookback: the hours before it are read row by row, one usage row
    // without its request an hour.
    await c.native(at(0, 60_000));
    await c.ready();
    await c.fill();
    const first = (await horizon(f.db)) - lookbackHours * 3_600_000;
    const from = (n: number) => new Date(first - n * 3_600_000).toISOString();
    for (let n = 1; n <= 800; n++)
      await c.usage(new Date(first - n * 3_600_000 + 60_000).toISOString());
    const under = await c.coverage(from(799), at(24));
    assert.equal(under.incomplete?.size, 799);
    assert.equal((await c.coverage(from(800), at(24))).incomplete, null);
  });
});

test("a count taken at exactly two hours past its hour is settled; a microsecond earlier it is not", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.ready();
    await c.fill();
    await f.db.query(
      "UPDATE basalt_model_capture_hours SET checked_at=hour + interval '2 hours' WHERE hour=$1",
      [at(2)],
    );
    await f.db.query(
      `UPDATE basalt_model_capture_hours SET checked_at=hour + interval '2 hours' - interval '1 microsecond'
      WHERE hour=$1`,
      [at(3)],
    );
    const read = await c.coverage(at(0), at(24));
    assert.deepEqual([...read.incomplete!], []);
    assert.deepEqual(spans(read.ranges), [[at(3), at(4)]], "only the unsettled count's hour");
    const plan = await planCaptureHours(f.db, lookbackHours);
    assert.deepEqual(plan?.pools[0]?.blocks.map(blockOf), [[blockStart(at(3)), 1]]);
  });
});

test("the plan reads in two statements, whatever the pools and the hours each one counts", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.ready();
    const statements = async (lookback: number) => {
      const read = recording(f.db);
      const plan = await planCaptureHours(read.db, lookback);
      return [read.seen.length, plan!.pools.length];
    };
    assert.deepEqual(await statements(lookbackHours), [2, 1]);
    await c.fill();
    assert.deepEqual(await statements(lookbackHours), [2, 1], "counted hours add none");
    assert.deepEqual(await statements(captureHoursLookbackHours), [2, 1], "400 days add none");
    // Two more pools ready on v16.
    await f.db.query(
      "INSERT INTO basalt_model_usage_people_ready (pool,through) VALUES ('aaaaaaaaaaaaaaaa',now()),('bbbbbbbbbbbbbbbb',now())",
    );
    assert.deepEqual(await statements(captureHoursLookbackHours), [2, 3], "pools add none");
  });
});

test("a block's counts equal its hours counted one by one, to the microsecond at its edges", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    const edge = Math.floor(Date.parse(at(30)) / (6 * 3_600_000)) * 6 * 3_600_000;
    const t = (ms: number, micro = "000") =>
      new Date(edge + ms).toISOString().replace("Z", `${micro}Z`);
    // Both sides of the block's start and end, inside it, and one past it.
    const times = [
      t(-1, "999"),
      t(0),
      t(1),
      t(3 * 3_600_000 - 1, "999"),
      t(6 * 3_600_000 - 1, "999"),
      t(6 * 3_600_000),
    ];
    for (const at of times) {
      await c.native(at);
      await c.usage(at);
      await c.native(at, true);
    }
    const charged = await c.usage(t(2 * 3_600_000), "not-a-key");
    await f.db.query("INSERT INTO billing_charge (id,usage_id,user_id) VALUES ($1,$2,7)", [
      String(charged),
      charged,
    ]);
    const rows = async () =>
      (
        await f.db.query(
          `SELECT pool, hour, usage_requests, uncaptured_requests FROM basalt_model_capture_hours
          ORDER BY pool, hour`,
        )
      ).rows.map((row) => [
        row.pool,
        (row.hour as Date).toISOString(),
        row.usage_requests,
        row.uncaptured_requests,
      ]);
    const blocks = [edge - 6 * 3_600_000, edge, edge + 6 * 3_600_000];
    for (const pool of [c.poolId, c.otherId])
      for (const from of blocks)
        assert.equal(
          (
            await countCaptureBlock(
              f.db,
              pool,
              new Date(from).toISOString(),
              new Date(from + 6 * 3_600_000).toISOString(),
              lots,
            )
          ).kind,
          "done",
        );
    const byBlock = await rows();
    await f.db.query("DELETE FROM basalt_model_capture_hours");
    for (const pool of [c.poolId, c.otherId])
      for (let at = blocks[0]!; at < blocks[2]! + 6 * 3_600_000; at += 3_600_000)
        assert.equal(
          (await countCaptureHour(f.db, pool, new Date(at).toISOString(), lots)).kind,
          "done",
        );
    assert.deepEqual(byBlock, await rows());
    // The edges land where they should: the hour before the block holds its last microsecond, the
    // block's first hour its two start rows.
    const of = (pool: string, at: number) =>
      byBlock.find((row) => row[0] === pool && row[1] === new Date(at).toISOString());
    assert.deepEqual(of(c.poolId, edge - 3_600_000)!.slice(2), [2, 1]);
    assert.deepEqual(of(c.poolId, edge)!.slice(2), [4, 2]);
    // The third hour: its last microsecond's captured and uncaptured rows, and the charged one.
    assert.deepEqual(of(c.poolId, edge + 2 * 3_600_000)!.slice(2), [3, 2]);
    assert.deepEqual(of(c.otherId, edge)!.slice(2), [2, 0], "the other pool's own rows only");
  });
});

test("a stored hour older than the lookback is read row by row, though its counts agree", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.ready();
    const first = (await horizon(f.db)) - captureHoursLookbackHours * 3_600_000;
    // Both hours settled long ago, with no usage and no request: equal counts.
    await f.db.query(
      `INSERT INTO basalt_model_capture_hours (pool,hour,usage_requests,uncaptured_requests,checked_at)
      SELECT $1, h, 0, 0, h + interval '3 hours'
      FROM unnest(ARRAY[$2::timestamptz - interval '1 hour', $2::timestamptz]) h`,
      [c.poolId, new Date(first).toISOString()],
    );
    // A usage row with no request in the old hour: only its row check can find it.
    await c.usage(new Date(first - 3_600_000 + 60_000).toISOString());
    const read = await c.coverage(
      new Date(first - 3_600_000).toISOString(),
      new Date(first + 3_600_000).toISOString(),
    );
    assert.deepEqual(
      [...read.incomplete!],
      [new Date(first - 3_600_000).toISOString().replace(".000Z", "Z")],
      "the row check found the old hour's missed row, though its stored counts agree",
    );
    assert.deepEqual(
      spans(read.ranges),
      [[new Date(first - 3_600_000).toISOString(), new Date(first).toISOString()]],
      "the hour before the lookback only; the one inside it is proven by its count",
    );
  });
});

test("with nothing older than the lookback, the prune takes no capture lock and reads no counts", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.native(at(0, 60_000), true);
    await c.ready();
    await c.fill();
    const stored = Number(
      (await f.db.query("SELECT count(*)::int AS n FROM basalt_model_capture_hours")).rows[0]!.n,
    );
    assert.ok(stored >= 2 * lookbackHours);
    const read = recording(f.db);
    const held = async () =>
      Number(
        (
          await f.db.query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=$1
            AND pid=pg_backend_pid()`,
            [captureHoursLockClass],
          )
        ).rows[0]!.n,
      );
    await f.db.query("BEGIN");
    try {
      assert.equal(await pruneCaptureHours(read.db, lookbackHours), 0);
      assert.equal(await held(), 0, "no pool's capture lock was taken");
    } finally {
      await f.db.query("ROLLBACK");
    }
    const prune = read.seen.find((entry) =>
      entry.text.includes("DELETE FROM basalt_model_capture_hours"),
    )!;
    const found = await shape(f.db, prune.text, prune.values);
    // One probe of the key per pool and one past the last, never the stored hours themselves.
    assert.ok(
      (found.reads.basalt_model_capture_hours ?? 0) <= 2 * 2 + 2,
      `the prune read ${found.reads.basalt_model_capture_hours} of ${stored} stored counts`,
    );
    // With old hours in one pool, only that pool's lock is taken.
    const first = (await horizon(f.db)) - lookbackHours * 3_600_000;
    await f.db.query(
      `INSERT INTO basalt_model_capture_hours (pool,hour,usage_requests,uncaptured_requests,checked_at)
      SELECT $1, h, 0, 0, h + interval '3 hours' FROM generate_series($2::timestamptz - interval '10 hours',
        $2::timestamptz - interval '1 hour', interval '1 hour') h`,
      [c.otherId, new Date(first).toISOString()],
    );
    await f.db.query("BEGIN");
    try {
      assert.equal(await pruneCaptureHours(f.db, lookbackHours), 10);
      assert.equal(await held(), 1, "only the pool with old hours was locked");
    } finally {
      await f.db.query("ROLLBACK");
    }
  });
});

test("a fully counted pool's summary reads the same complete hours, known days and partial as the per-row check", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    const now = Date.now();
    // Three weeks of requests, one every seven hours, and one usage row the capture missed.
    for (let at = now - 21 * 86_400_000; at < now - 3_600_000; at += 7 * 3_600_000)
      await c.native(new Date(at).toISOString());
    await c.usage(new Date(now - 10 * 86_400_000 + 1_800_000).toISOString());
    const forward = Number((await f.db.query("SELECT max(id)::int AS id FROM usage")).rows[0]!.id);
    await c.cursor(forward);
    await c.ready();
    await fillByTicks(f.db, captureHoursLookbackHours);
    // Every statement each summary ran, so the test can prove which capture path it took.
    let ran: string[] = [];
    const recorded = {
      query: (text: string, values?: unknown[]) => {
        ran.push(text);
        return f.db.query(text, values);
      },
    };
    const summary = () => {
      ran = [];
      return poolUsageSummary(
        recorded,
        {
          pool,
          from: new Date(now - 14 * 86_400_000).toISOString(),
          to: new Date(now).toISOString(),
          authority: c.authority,
        },
        async () => ({ prices: summaryPrices, issues: [] }),
        now,
      );
    };
    const readCounts = () => ran.some((text) => text.includes("JOIN basalt_model_capture_hours"));
    const view = (result: Awaited<ReturnType<typeof summary>>) => ({
      status: result.homeCapture.status,
      completeHours: result.homeCapture.completeHours,
      knownDays: result.historyCoverage.knownDays,
      gapDays: result.historyCoverage.gapDays,
      partial: result.partial,
    });
    const counted = view(await summary());
    assert.ok(readCounts(), "the counted side read the stored counts");
    assert.equal(counted.status, "partial", "the missed row's hour is incomplete");
    assert.ok(counted.completeHours.length > 300, `${counted.completeHours.length} complete hours`);
    // The per-row check, as before v17.
    await f.db.query("DROP TABLE basalt_model_capture_hours");
    await f.db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyCaptureHoursVersion,
    ]);
    const perRow = view(await summary());
    assert.ok(!readCounts(), "the per-row side read no stored counts");
    assert.deepEqual(counted, perRow);
  });
});
