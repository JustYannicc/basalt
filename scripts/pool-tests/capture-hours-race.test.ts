import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import {
  countBlockStatement,
  countCaptureBlock,
  countCaptureHour,
} from "../../src/pool/model-history/capture-hours-count.ts";
import { poolUsernamePattern } from "../../src/pool/model-history/capture-population.ts";
import { homeHistorySelect, homeRequest } from "../../src/pool/model-history/home.ts";
import { insertRequests } from "../../src/pool/model-history/store.ts";
import { at, captureFixture, clockAt, hourMs } from "./capture-hours-fixture.ts";
import { seriesFixture } from "./series-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
type Capture = Awaited<ReturnType<typeof captureFixture>>;
const minute = 60_000;
const hourOf = (time: string) =>
  new Date(Math.floor(Date.parse(time) / hourMs) * hourMs).toISOString();

/** Another session on the fixture's schema and clock, as a second writer or the counting pass. */
async function session(f: Fixture) {
  const client = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL });
  await client.connect();
  await client.query(`SET search_path TO ${f.schema}, pg_catalog`);
  return client;
}

/** Both pools counted over the lookback, with the database clock half an hour into this hour. */
async function counted(f: Fixture) {
  await clockAt(f, Math.floor(Date.now() / hourMs) * hourMs + 30 * minute);
  const c = await captureFixture(f);
  await c.native(at(2, minute));
  await c.native(at(2, minute), true);
  await c.ready();
  await c.fill();
  return c;
}

/** The request capture would write for one Home usage row. */
async function requestFor(f: Fixture, c: Capture, usageId: number) {
  const raw = (await f.db.query(`${homeHistorySelect} WHERE u.id = $1`, [usageId])).rows[0];
  return homeRequest(raw, c.source);
}

/** A Home usage row of the pool's user with no request yet: what a late capture or import fills. */
const lateRow = (c: Capture, hours: number, offset: number) => c.usage(at(hours, offset));

/** What a count of the hour taken now would store, read in a transaction that is rolled back. */
async function truth(f: Fixture, c: Capture, hour: string) {
  await f.db.query("BEGIN");
  try {
    await f.db.query(countBlockStatement, [
      c.poolId,
      hour,
      new Date(Date.parse(hour) + hourMs).toISOString(),
      poolUsernamePattern(c.poolId),
      c.source,
    ]);
    const row = (
      await f.db.query(
        "SELECT usage_requests, uncaptured_requests FROM basalt_model_capture_hours WHERE pool=$1 AND hour=$2",
        [c.poolId, hour],
      )
    ).rows[0]!;
    return { usage: Number(row.usage_requests), uncaptured: Number(row.uncaptured_requests) };
  } finally {
    await f.db.query("ROLLBACK");
  }
}

/**
 * The hour is pending (no count, or one taken before it settled) or holds exactly what a count
 * taken now would: never a stale count standing.
 */
async function pendingOrFresh(f: Fixture, c: Capture, hour: string, label: string) {
  const row = (
    await f.db.query(
      `SELECT usage_requests, uncaptured_requests, checked_at >= hour + interval '2 hours' AS settled
      FROM basalt_model_capture_hours WHERE pool=$1 AND hour=$2`,
      [c.poolId, hour],
    )
  ).rows[0];
  if (!row || row.settled !== true) return "pending";
  assert.deepEqual(
    { usage: Number(row.usage_requests), uncaptured: Number(row.uncaptured_requests) },
    await truth(f, c, hour),
    `${label}: a settled count that differs from a count taken now`,
  );
  return "fresh";
}

/** Waits until `client`'s backend is waiting on a lock, or `ms` passed. */
async function blocked(f: Fixture, client: pg.Client, ms = 1_000) {
  const pid = (client as unknown as { processID: number }).processID;
  for (const end = Date.now() + ms; Date.now() < end;) {
    const row = (
      await f.db.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])
    ).rows[0];
    if (row?.wait_event_type === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

for (const existing of [true, false] as const)
  test(`an insert that fills a settled hour while a count of that hour reads never leaves a stale count (${existing ? "the hour has a count" : "the hour is pending"})`, async () => {
    await seriesFixture(async (f) => {
      const c = await counted(f);
      const hour = hourOf(at(2));
      const usageId = await lateRow(c, 2, 30 * minute);
      // The stored count saw the late row without its request: one uncaptured, as capture lags.
      const left = () => 60_000;
      assert.equal((await countCaptureHour(f.db, c.poolId, hour, left)).kind, "done");
      if (!existing)
        await f.db.query("DELETE FROM basalt_model_capture_hours WHERE pool=$1 AND hour=$2", [
          c.poolId,
          hour,
        ]);
      const request = await requestFor(f, c, usageId);
      const writer = await session(f);
      const counter = await session(f);
      try {
        // The writer's insert is in but not committed when the count takes its snapshot.
        await writer.query("BEGIN");
        await insertRequests(writer, [request], true);
        const counting = countCaptureHour(counter, c.poolId, hour, left, 10_000);
        assert.ok(await blocked(f, counter, 2_000), "the count waited on the writer's mark");
        await writer.query("COMMIT");
        const outcome = await counting;
        assert.ok(["done", "lock"].includes(outcome.kind), outcome.kind);
        await pendingOrFresh(f, c, hour, "after the race");
      } finally {
        await writer.query("ROLLBACK").catch(() => {});
        await Promise.all([writer.end(), counter.end()]);
      }
    });
  });

/** Holds one pool-hour's count row in an open transaction, so writers meet in the middle. */
async function hold(f: Fixture, c: Capture, hour: string) {
  const holder = await session(f);
  await holder.query("BEGIN");
  await holder.query(
    "SELECT 1 FROM basalt_model_capture_hours WHERE pool=$1 AND hour=$2 FOR UPDATE",
    [c.poolId, hour],
  );
  return holder;
}

/** One import of `records` in its own transaction, as the import endpoint runs it. */
const importing = async (client: pg.Client, records: Awaited<ReturnType<typeof requestFor>>[]) => {
  await client.query("BEGIN");
  try {
    await insertRequests(client, records, true);
    return client;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
};

const hours = [3, 4, 5, 6, 7, 8];

/**
 * A late Home row in each hour, for each of `writers`, with the requests that fill them. One row at
 * a time: the fixture's usage helper hands back its shared counter, so concurrent calls would all
 * get the last row's id.
 */
async function late(f: Fixture, c: Capture, writers: number, round = 0) {
  const ids: number[][] = [];
  for (const n of hours) {
    const row: number[] = [];
    for (let w = 0; w < writers; w++)
      row.push(await lateRow(c, n, (round * writers + w + 1) * 1_000));
    ids.push(row);
  }
  const requests: Awaited<ReturnType<typeof requestFor>>[][] = [];
  for (let w = 0; w < writers; w++) {
    const mine: Awaited<ReturnType<typeof requestFor>>[] = [];
    for (const row of ids) mine.push(await requestFor(f, c, row[w]!));
    requests.push(mine);
  }
  return requests;
}

test("two imports that fill the same hours in opposite orders, meeting mid-block, both finish: marks lock in (pool, hour) order (a mark that locks in its rows' order deadlocks here)", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const [mine, theirs] = await late(f, c, 2);
    // A third session holds the block's fourth hour: the first import, in order, takes the three
    // before it and waits; the second, its rows the other way round, then reaches the same hours.
    const holder = await hold(f, c, hourOf(at(hours[3]!)));
    const [first, second] = await Promise.all([session(f), session(f)]);
    try {
      const one = importing(first, mine!);
      assert.ok(await blocked(f, first), "the first import waits on the held hour");
      const two = importing(second, theirs!.reverse());
      assert.ok(await blocked(f, second), "the second import waits too");
      await holder.query("COMMIT");
      const results = await Promise.allSettled([
        one.then((client) => client.query("COMMIT")),
        two.then((client) => client.query("COMMIT")),
      ]);
      for (const result of results)
        assert.equal(
          result.status,
          "fulfilled",
          result.status === "rejected" ? String(result.reason) : "",
        );
      for (const n of hours) await pendingOrFresh(f, c, hourOf(at(n)), `hour ${n}`);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await Promise.all([holder.end(), first.end(), second.end()]);
    }
  });
});

test("an import and a block count that meet mid-block both finish, and every hour ends pending or freshly counted", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const [records] = await late(f, c, 1);
    const holder = await hold(f, c, hourOf(at(hours[3]!)));
    const [writer, counter] = await Promise.all([session(f), session(f)]);
    try {
      // The count takes the block's hours in order and meets the held one; the import too.
      const counting = countCaptureBlock(
        counter,
        c.poolId,
        hourOf(at(hours[0]!)),
        hourOf(at(hours.at(-1)! + 1)),
        () => 60_000,
        10_000,
      );
      assert.ok(await blocked(f, counter), "the count waits on the held hour");
      const writing = importing(writer, records!);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await holder.query("COMMIT");
      const [count, write] = await Promise.allSettled([
        counting,
        writing.then((client) => client.query("COMMIT")),
      ]);
      assert.equal(
        write.status,
        "fulfilled",
        write.status === "rejected" ? String(write.reason) : "",
      );
      assert.equal(
        count.status,
        "fulfilled",
        count.status === "rejected" ? String(count.reason) : "",
      );
      for (const n of hours) await pendingOrFresh(f, c, hourOf(at(n)), `hour ${n}`);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await Promise.all([holder.end(), writer.end(), counter.end()]);
    }
  });
});

test("imports and block counts of the same pool-hours, raced over many rounds, never deadlock and never leave a stale count", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const sessions = await Promise.all([session(f), session(f), session(f)]);
    const [first, second, counter] = sessions;
    try {
      for (let round = 0; round < 40; round++) {
        const [ascending, other] = await late(f, c, 2, round);
        const results = await Promise.allSettled([
          insertRequests(first, ascending!, true),
          insertRequests(second, other!.reverse(), true),
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, round % 4));
            return countCaptureBlock(
              counter,
              c.poolId,
              hourOf(at(hours[0]!)),
              hourOf(at(hours.at(-1)! + 1)),
              () => 60_000,
              10_000,
            );
          })(),
        ]);
        for (const result of results)
          assert.equal(
            result.status,
            "fulfilled",
            result.status === "rejected" ? String(result.reason) : "",
          );
        for (const n of hours) await pendingOrFresh(f, c, hourOf(at(n)), `round ${round}`);
      }
    } finally {
      await Promise.all(sessions.map((client) => client.end()));
    }
  });
});
