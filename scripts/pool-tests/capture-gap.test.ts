import assert from "node:assert/strict";
import { test } from "node:test";
import {
  historyGapBehindCap,
  logHistoryGap,
  readHistoryGap,
} from "../../src/pool/model-history/capture-gap.ts";
import { countCaptureHour } from "../../src/pool/model-history/capture-hours-count.ts";
import { runModelHistoryPass } from "../../src/pool/model-history/pass.ts";
import { at, captureFixture, clockAt, hourMs } from "./capture-hours-fixture.ts";
import { seriesFixture } from "./series-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
const minute = 60_000;
const week = 168;

/**
 * Both pools counted over the gap's seven days, Home's cursor at its head. The database clock stands
 * half an hour into the current hour, so no hour settles while a test runs.
 */
async function caughtUp(f: Fixture) {
  await clockAt(f, Math.floor(Date.now() / hourMs) * hourMs + 30 * minute);
  const c = await captureFixture(f);
  await c.native(at(2, minute));
  await c.native(at(2, minute), true);
  await c.ready();
  await c.fill(week);
  const head = Number(
    (await f.db.query("SELECT coalesce(max(id),0)::int AS id FROM usage")).rows[0]!.id,
  );
  await c.cursor(head);
  return c;
}

test("a pool caught up and counted reads no gap", async () => {
  await seriesFixture(async (f) => {
    await caughtUp(f);
    assert.deepEqual(await readHistoryGap(f.db), {
      behind: 0,
      uncaptured7d: 0,
      uncountedHours7d: 0,
    });
  });
});

test("rows past the cursor, a row history lacks and an hour not counted yet each show in their own count", async () => {
  await seriesFixture(async (f) => {
    const c = await caughtUp(f);
    // Two rows Home wrote since capture's last pass.
    await c.usage(new Date().toISOString());
    await c.usage(new Date().toISOString());
    // A late Home row in a settled hour with no history row, counted as such.
    await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES (500,$1,$2)", [
      at(3, 10 * minute),
      c.fingerprint,
    ]);
    const hour = new Date(Math.floor(Date.parse(at(3)) / hourMs) * hourMs).toISOString();
    assert.equal((await countCaptureHour(f.db, c.poolId, hour, () => 60_000)).kind, "done");
    // An hour a history write marked pending.
    await f.db.query(
      "UPDATE basalt_model_capture_hours SET checked_at='-infinity' WHERE pool=$1 AND hour=$2",
      [c.poolId, new Date(Math.floor(Date.parse(at(4)) / hourMs) * hourMs).toISOString()],
    );
    assert.deepEqual(await readHistoryGap(f.db), {
      behind: 2,
      uncaptured7d: 1,
      uncountedHours7d: 1,
    });
  });
});

test("a ready pool never counted reads every hour of the window uncounted", async () => {
  await seriesFixture(async (f) => {
    const c = await caughtUp(f);
    await f.db.query("DELETE FROM basalt_model_capture_hours WHERE pool=$1", [c.otherId]);
    assert.deepEqual(await readHistoryGap(f.db), {
      behind: 0,
      uncaptured7d: 0,
      uncountedHours7d: week,
    });
  });
});

test("counts just outside the window count for nothing", async () => {
  await seriesFixture(async (f) => {
    const c = await caughtUp(f);
    const horizon = (
      await f.db.query(
        "SELECT date_trunc('hour', transaction_timestamp() - interval '2 hours', 'UTC') AS at",
      )
    ).rows[0]!.at as Date;
    // An hour before the window and the horizon's own hour, both settled with rows history lacks.
    for (const at of [horizon.getTime() - (week + 1) * hourMs, horizon.getTime()])
      await f.db.query(
        `INSERT INTO basalt_model_capture_hours (pool,hour,usage_requests,uncaptured_requests,checked_at)
        VALUES ($1,$2,5,5,$2::timestamptz + interval '3 hours')
        ON CONFLICT (pool,hour) DO UPDATE SET uncaptured_requests=5, checked_at=EXCLUDED.checked_at`,
        [c.poolId, new Date(at).toISOString()],
      );
    assert.deepEqual(await readHistoryGap(f.db), {
      behind: 0,
      uncaptured7d: 0,
      uncountedHours7d: 0,
    });
  });
});

test("before the capture-hour counts are applied, only the rows past the cursor are counted", async () => {
  await seriesFixture(async (f) => {
    const c = await caughtUp(f);
    await c.usage(new Date().toISOString());
    await f.db.query(
      "DELETE FROM basalt_model_history_migrations WHERE name='model_request_history_v17_capture_hours'",
    );
    assert.deepEqual(await readHistoryGap(f.db), {
      behind: 1,
      uncaptured7d: null,
      uncountedHours7d: null,
    });
  });
});

test("the count past the cursor stops at its cap and one", async () => {
  await seriesFixture(async (f) => {
    const c = await caughtUp(f);
    await f.db.query(
      `INSERT INTO usage (id,timestamp,api_key)
      SELECT 100000 + n, now(), $1 FROM generate_series(1, $2::int) n`,
      [c.fingerprint, historyGapBehindCap + 5],
    );
    assert.equal((await readHistoryGap(f.db))?.behind, historyGapBehindCap + 1);
  });
});

test("no line while capture is not active, and the line carries counts only", async (t) => {
  await seriesFixture(async (f) => {
    await caughtUp(f);
    const lines: unknown[][] = [];
    t.mock.method(console, "info", (...args: unknown[]) => void lines.push(args));
    await logHistoryGap(f.db);
    assert.equal(lines.length, 1);
    const [name, fields] = lines[0] as [string, Record<string, unknown>];
    assert.equal(name, "POOL_MODEL_HISTORY_GAP");
    assert.deepEqual(Object.keys(fields).sort(), ["behind", "uncaptured7d", "uncountedHours7d"]);
    assert.ok(Object.values(fields).every((value) => typeof value === "number"));
    await f.db.query("DELETE FROM basalt_model_history_cursor");
    assert.equal(await logHistoryGap(f.db), undefined);
    assert.equal(lines.length, 1, "inactive capture writes no line");
  });
});

test("a draining handover skips the gap's read", async () => {
  await seriesFixture(async (f) => {
    await caughtUp(f);
    const steps: string[] = [];
    await runModelHistoryPass(
      {
        session: (work) => work(f.db),
        publish: async () => {},
        rollup: async () => void steps.push("rollup"),
        hours: async () => void steps.push("hours"),
        gap: async () => void steps.push("gap"),
        stopped: () => true,
      },
      { rows: 0 },
    );
    assert.ok(!steps.includes("gap"), JSON.stringify(steps));
  });
});

test("the pass reads the gap last, and a failed read costs only the line", async (t) => {
  await seriesFixture(async (f) => {
    await caughtUp(f);
    const steps: string[] = [];
    const errors: unknown[] = [];
    t.mock.method(console, "error", (name: unknown) => void errors.push(name));
    const progress = { rows: 0 };
    await runModelHistoryPass(
      {
        session: (work) => work(f.db),
        publish: async () => {},
        rollup: async () => void steps.push("rollup"),
        hours: async () => void steps.push("hours"),
        gap: async () => {
          steps.push("gap");
          throw new Error("fixture failure");
        },
        stopped: () => false,
      },
      progress,
    );
    assert.deepEqual(steps, ["rollup", "hours", "gap"]);
    assert.deepEqual(errors, ["POOL_MODEL_HISTORY_GAP_PENDING"]);
  });
});
