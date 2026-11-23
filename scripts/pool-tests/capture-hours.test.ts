import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { homeCaptureCoverage } from "../../src/pool/model-history/capture-coverage.ts";
import {
  countCaptureHour,
  countHourStatement,
} from "../../src/pool/model-history/capture-hours-count.ts";
import {
  captureHoursLookbackHours,
  planCaptureHours,
} from "../../src/pool/model-history/capture-hours-plan.ts";
import { poolUsernamePattern } from "../../src/pool/model-history/capture-population.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { at, captureFixture, hourKey, lookbackHours, recording } from "./capture-hours-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

const lots = () => 60_000;
type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];

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

test("hours the tick never counted are unproven: incomplete, and never read row by row", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.native(at(30, 60_000));
    // A missing request inside the uncounted day: the per-row check would find it, so a read of
    // that day would show as a range below.
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
      [...read.incomplete!].sort(),
      Array.from({ length: 24 }, (_, n) => hourKey(4 + n)),
      "every uncounted hour is unproven",
    );
    assert.equal(read.ranges, undefined, "and none of them is read row by row");
  });
});

test("a count taken before its hour settled is uncounted: unproven to the summary and pending for the tick", async () => {
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
    assert.deepEqual([...read.incomplete!], [hourKey(2)]);
    assert.equal(read.ranges, undefined);
    const plan = await planCaptureHours(f.db, lookbackHours);
    assert.deepEqual(
      plan?.pools.map((item) => [item.pool, item.pending, item.hours]),
      [[c.poolId, 1, [hourKey(2)]]],
    );
    await c.fill();
    assert.deepEqual([...(await c.coverage(at(0), at(24))).incomplete!], []);
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
    const count = await shape(f.db, countHourStatement, [
      c.poolId,
      at(10),
      poolUsernamePattern(c.poolId),
      c.source,
    ]);
    assert.equal(count.reads.usage, 50, "one hour's usage rows");
    assert.ok(count.indexes.has("fixture_usage_time"), [...count.indexes].join(" "));
    assert.ok(!count.seq.has("usage"), "no scan of all usage");
    const read = recording(f.db);
    await homeCaptureCoverage(
      read.db,
      c.poolId,
      c.source,
      at(0, 1_800_000),
      new Date().toISOString(),
      true,
    );
    const capture = read.seen.filter((entry) => !entry.text.includes("to_regclass('usage')"));
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
    assert.deepEqual(
      plan.map((item) => [item.pool, item.pending, item.hours.length]),
      [[c.poolId, 9_600, 2_000]],
      "400 days of hours, whatever the pool's first request, listed 2,000 at a time",
    );
    const hour = (n: number) => new Date(end - n * 3_600_000).toISOString().replace(".000Z", "Z");
    assert.deepEqual(plan[0]!.hours.slice(0, 3), [hour(1), hour(2), hour(3)], "newest first");
    assert.equal(plan[0]!.hours.at(-1), hour(2_000));
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

test("hours of a window older than the lookback stay unproven, never complete", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, 60_000));
    await c.ready();
    await c.fill();
    const first = (await horizon(f.db)) - lookbackHours * 3_600_000;
    const before = (n: number) => new Date(first - n * 3_600_000).toISOString();
    const read = await c.coverage(before(4), at(24));
    assert.deepEqual(
      [...read.incomplete!].sort(),
      [4, 3, 2, 1].map((n) => before(n).replace(".000Z", "Z")),
      "the four hours before the lookback, and only those",
    );
    assert.equal(read.ranges, undefined, "and none of them is read row by row");
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
    // Ready and counted over the lookback: hours before it are unproven.
    await c.native(at(0, 60_000));
    await c.ready();
    await c.fill();
    const first = (await horizon(f.db)) - lookbackHours * 3_600_000;
    const from = (n: number) => new Date(first - n * 3_600_000).toISOString();
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
    assert.deepEqual([...read.incomplete!], [hourKey(3)]);
    const plan = await planCaptureHours(f.db, lookbackHours);
    assert.deepEqual(plan?.pools[0]?.hours, [hourKey(3)]);
  });
});
