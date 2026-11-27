import assert from "node:assert/strict";
import { test } from "node:test";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { digest } from "../../src/pool/backend-users.ts";
import {
  sweepCheckIds,
  sweepCheckLimitMs,
  sweepIdsPerSession,
  sweepLateCommits,
  sweepReachIds,
} from "../../src/pool/model-history/capture-sweep.ts";
import { homeHistorySource } from "../../src/pool/model-history/home.ts";
import { HistoryTimeoutFailure } from "../../src/pool/model-history/series-deadline.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { historyBatchSize } from "../../src/pool/model-history/store.ts";
import { addHome, admin, captured, fixture } from "./capture-fixture.ts";

/** One capture session after each entry's Home rows arrive: what its sweep and pages did. */
async function sessions(db: HistoryDatabase, arrivals: readonly number[]) {
  const read: { swept: number; fresh: number; inserted: number }[] = [];
  for (const rows of arrivals) {
    if (rows) await addHome(db, rows);
    const result = await captureHomeRequests(db);
    assert.equal(result.state, "active");
    if (result.state === "active")
      read.push({ swept: result.swept, fresh: result.fresh, inserted: result.inserted });
  }
  return read;
}

/** Home rows with the ids `from` to `to`, alternating between the two pools' keys. */
async function homeRows(db: HistoryDatabase, from: number, to: number) {
  await db.query(
    `INSERT INTO usage(id,timestamp,request_id,api_key)
    SELECT n,now(),'attempt-' || n,'sha256:' || lpad(((n % 2) + 1)::text,64,'0')
    FROM generate_series($1::int,$2::int) n`,
    [from, to],
  );
}

const total = (read: readonly { swept: number }[]) =>
  read.reduce((sum, session) => sum + session.swept, 0);

test("the late-commit sweep checks each row once, and an idle session checks none", () =>
  fixture(async ({ db }) => {
    const rows = historyBatchSize + 50;
    const read = await sessions(db, [rows, 0, 0, 0, 0, 0]);
    assert.equal(await captured(db), rows);
    assert.equal(total(read), rows, `every row checked once: ${JSON.stringify(read)}`);
    assert.deepEqual(
      read.slice(-2).map((session) => session.swept),
      [0, 0],
      `idle sessions check nothing: ${JSON.stringify(read)}`,
    );
  }));

test("under traffic above a page a session, the sweep keeps up with what the pages read", () =>
  fixture(async ({ db }) => {
    const busy = 2 * historyBatchSize;
    const read = await sessions(db, [busy, busy, busy, busy, 0, 0, 0]);
    assert.equal(await captured(db), 4 * busy);
    assert.equal(total(read), 4 * busy, `every row checked once: ${JSON.stringify(read)}`);
    // Each session checks what the pages read two sessions before.
    for (const [index, session] of read.entries())
      if (index >= 2)
        assert.ok(
          session.swept >= read[index - 2]!.fresh,
          `session ${index} checked ${session.swept}: ${JSON.stringify(read)}`,
        );
    assert.equal(read.at(-1)!.swept, 0, `idle sessions check nothing: ${JSON.stringify(read)}`);
  }));

test("traffic above one check's ids a session is kept up with, not left to fall past the reach", () =>
  fixture(async ({ db }) => {
    const busy = (sweepCheckIds * 3) / 2;
    const read = await sessions(db, [busy, busy, busy, busy, busy, 0, 0, 0]);
    assert.equal(total(read), 5 * busy, `every row checked once: ${JSON.stringify(read)}`);
    // Each session checks all the pages read two sessions before, so the sweep never falls behind.
    for (const [index, session] of read.entries())
      if (index >= 2)
        assert.ok(
          session.swept >= read[index - 2]!.fresh,
          `session ${index} checked ${session.swept}: ${JSON.stringify(read)}`,
        );
  }));

test("rows that commit below the cursor after the pages passed them are captured, a batch a session", () =>
  fixture(async ({ db }) => {
    await homeRows(db, 1, 100);
    await homeRows(db, 351, 450);
    assert.equal((await captureHomeRequests(db)).state, "active");
    // The pages passed ids 101 to 350 while their rows had not committed.
    await homeRows(db, 101, 350);
    const read = await sessions(db, [0, 0, 0, 0, 0]);
    assert.equal(await captured(db), 450);
    assert.deepEqual(
      read.map((session) => session.inserted),
      [0, historyBatchSize, 250 - historyBatchSize, 0, 0],
      JSON.stringify(read),
    );
    assert.equal(total(read), 450, `every id checked once: ${JSON.stringify(read)}`);
  }));

test("after the release, a table far past the sweep's reach has only its last reach of ids checked, once", () =>
  fixture(async ({ db }) => {
    const head = 120_600;
    const reach = head - Number(sweepReachIds);
    await homeRows(db, 1, 300);
    await homeRows(db, reach - 49, reach + 50);
    await homeRows(db, head - 599, head);
    const first = await captureHomeRequests(db);
    assert.ok(first.state === "active" && first.caughtUp);
    // The full-table cycle earlier code leaves behind: partway, and ending far behind the cursor.
    await db.query("UPDATE basalt_model_history_cursor SET sweep_id=100, sweep_upper=400");
    const read = await sessions(db, [0, 0, 0, 0]);
    assert.equal(total(read), 50 + 600, `only ids within reach, once: ${JSON.stringify(read)}`);
    assert.deepEqual(
      read.slice(-2).map((session) => session.swept),
      [0, 0],
      JSON.stringify(read),
    );
    assert.equal(await captured(db), 300 + 100 + 600);
  }));

test("a row whose key moved to another pool after capture is checked once and never read again", () =>
  fixture(async ({ db }) => {
    const rows = 300;
    await addHome(db, rows);
    assert.equal((await captureHomeRequests(db)).state, "active");
    await db.query("UPDATE api_key SET user_id=2 WHERE id=1");
    const read = await sessions(db, [0, 0, 0, 0, 0]);
    assert.equal(total(read), rows, JSON.stringify(read));
    assert.ok(
      read.every((session) => session.inserted === 0),
      JSON.stringify(read),
    );
    assert.deepEqual(
      read.slice(-2).map((session) => session.swept),
      [0, 0],
      JSON.stringify(read),
    );
    assert.equal(await captured(db), rows);
  }));

test("a range longer than one session's checks goes on where the last session stopped", () =>
  fixture(async ({ db }) => {
    const ids = sweepIdsPerSession + 400;
    const late = sweepIdsPerSession + 200;
    await homeRows(db, 1, late - 1);
    await homeRows(db, late + 1, ids);
    const first = await captureHomeRequests(db);
    assert.ok(first.state === "active" && first.caughtUp);
    // Past the first session's checks, a row commits after the pages passed its id.
    await homeRows(db, late, late);
    const read = await sessions(db, [0, 0, 0, 0, 0]);
    assert.deepEqual(
      read.map((session) => session.swept),
      [0, sweepIdsPerSession, ids - sweepIdsPerSession, 0, 0],
      JSON.stringify(read),
    );
    assert.deepEqual(
      read.map((session) => session.inserted),
      [0, 0, 1, 0, 0],
      JSON.stringify(read),
    );
    assert.equal(await captured(db), ids);
  }));

test("after an activation over existing rows, the sweep reads none the backfill owns and still catches late rows above them", () =>
  fixture(async ({ db }) => {
    const backfill = 1_000;
    await homeRows(db, 1, backfill);
    // As activation over existing rows leaves it: the backfill still to run below the cursor.
    await db.query(
      `UPDATE basalt_model_history_cursor SET forward_id=$1, backfill_upper=$1, backfill_id=0,
      backfill_complete=false, sweep_id=0, sweep_upper=0`,
      [backfill],
    );
    let owned = 0;
    const counted: HistoryDatabase = {
      query: async (text, values) => {
        const result = await db.query(text, values);
        if (text.includes("WHERE u.id = ANY"))
          owned += result.rows.filter((row) => Number(row.source_id) <= backfill).length;
        return result;
      },
    };
    let next = backfill + 1;
    for (let session = 0; session < 9; session++) {
      const gap = next + 150;
      if (session < 6) {
        await homeRows(db, next, gap - 1);
        await homeRows(db, gap + 1, next + 299);
        next += 300;
      }
      assert.equal((await captureHomeRequests(counted)).state, "active");
      // The id the pages just passed commits now.
      if (session < 6) await homeRows(db, gap, gap);
    }
    assert.equal(owned, 0, "the sweep read rows the backfill owns");
    assert.equal(await captured(db), next - 1, "every row, the late ones included");
  }));

/** The cursor's sweep fields. */
const sweepFields = async (db: HistoryDatabase) =>
  (
    await db.query(
      "SELECT sweep_id::text AS id, sweep_upper::text AS upper FROM basalt_model_history_cursor",
    )
  ).rows[0];

/** As the driver reports a statement Postgres cancelled at its limit. */
const cancelled = () =>
  Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
    severity: "ERROR",
  });
/** As a capture session reports it: the timeout's own reason, with the driver's error as cause. */
const sessionCancelled = () =>
  Object.assign(new HistoryTimeoutFailure("statement_timeout"), { cause: cancelled() });

/**
 * Sessions through `db` whose sweep checks fail as `fail` says, by their place in the session: as
 * Postgres fails a statement, it leaves the transaction aborted. Records the session's statement
 * limit where it stores its cursor.
 */
function failingChecks(
  db: HistoryDatabase,
  fail: (check: number) => Error | undefined,
  limits: string[] = [],
): HistoryDatabase {
  let checks = 0;
  return {
    query: async (text, values) => {
      if (text.startsWith("WITH s AS MATERIALIZED")) {
        const error = fail(checks++);
        if (error) {
          await db.query("SELECT 1/0").catch(() => {});
          throw error;
        }
      }
      if (text.includes("UPDATE basalt_model_history_cursor SET sweep_id"))
        limits.push(
          String(
            (await db.query("SELECT current_setting('statement_timeout') AS limit")).rows[0]!.limit,
          ),
        );
      return db.query(text, values);
    },
  };
}

test("a check cut short costs only that session's sweep: its pages land, and the range is checked next session", () =>
  fixture(async ({ db }) => {
    await sessions(db, [300, 0]);
    const pending = await sweepFields(db);
    assert.deepEqual(pending, { id: "0", upper: "300" });
    // Rows the cut session's own page must still capture.
    await addHome(db, 50);
    const limits: string[] = [];
    const cut = await captureHomeRequests(failingChecks(db, () => sessionCancelled(), limits));
    assert.ok(cut.state === "active");
    assert.equal(cut.fresh, 50, "the forward page landed");
    assert.equal(cut.swept, 0);
    assert.equal(cut.sweepDeferred, true);
    assert.equal(await captured(db), 350);
    assert.deepEqual(await sweepFields(db), pending, "the range is neither skipped nor finished");
    const after = [];
    for (let session = 0; session < 3; session++) {
      const result = await captureHomeRequests(failingChecks(db, () => undefined, limits));
      assert.ok(result.state === "active");
      after.push(result.swept);
    }
    assert.deepEqual(after, [300, 50, 0], "every id checked once after the cut");
    assert.deepEqual(limits, ["5s", "5s", "5s", "5s"], "the session's own limit is back each time");
  }));

test("a session's later check cut short keeps what its earlier checks did", () =>
  fixture(async ({ db }) => {
    const rows = sweepCheckIds + 500;
    await sessions(db, [rows, 0]);
    assert.deepEqual(await sweepFields(db), { id: "0", upper: String(rows) });
    const cut = await captureHomeRequests(
      failingChecks(db, (check) => (check === 1 ? cancelled() : undefined)),
    );
    assert.ok(cut.state === "active");
    assert.equal(cut.swept, sweepCheckIds);
    assert.equal(cut.sweepDeferred, true);
    assert.deepEqual(
      await sweepFields(db),
      { id: String(sweepCheckIds), upper: String(rows) },
      "the first check's ids are done; the rest of the range waits",
    );
    const after = await sessions(db, [0, 0, 0]);
    assert.deepEqual(
      after.map((session) => session.swept),
      [500, 0, 0],
    );
  }));

test("a check failing any other way fails its session and keeps nothing", () =>
  fixture(async ({ db }) => {
    await sessions(db, [300, 0]);
    const before = await sweepFields(db);
    await addHome(db, 50);
    const broken = Object.assign(new Error("fixture failure"), {
      code: "XX000",
      severity: "ERROR",
    });
    await assert.rejects(
      captureHomeRequests(failingChecks(db, () => broken)),
      (error) => error === broken,
    );
    assert.equal(await captured(db), 300, "no page ran");
    assert.deepEqual(await sweepFields(db), before);
  }));

test(
  "a check Postgres cancels at its own limit leaves the session's pages to land",
  { skip: admin ? false : "needs real Postgres for a real statement timeout" },
  () =>
    fixture(async ({ db }) => {
      await sessions(db, [300, 0]);
      await addHome(db, 50);
      const slow: HistoryDatabase = {
        query: (text, values) =>
          text.startsWith("WITH s AS MATERIALIZED")
            ? db.query("SELECT pg_sleep(4)")
            : db.query(text, values),
      };
      const started = performance.now();
      const cut = await captureHomeRequests(slow);
      assert.ok(cut.state === "active");
      assert.equal(cut.fresh, 50);
      assert.equal(cut.sweepDeferred, true);
      assert.ok(performance.now() - started < 4_000, "the check stopped at its own limit");
      assert.equal(await captured(db), 350);
    }),
);

test("rows history lacks across one session's checks share its one batch, and the rest come next session", () =>
  fixture(async ({ db }) => {
    await homeRows(db, 1, 100);
    await homeRows(db, 251, 2100);
    await homeRows(db, 2201, 4000);
    assert.equal((await captureHomeRequests(db)).state, "active");
    // The pages passed 150 ids in the first check's part of the range and 100 in the second's.
    await homeRows(db, 101, 250);
    await homeRows(db, 2101, 2200);
    const read = await sessions(db, [0, 0, 0, 0]);
    assert.deepEqual(
      read.map((session) => session.inserted),
      [0, 200, 50, 0],
      JSON.stringify(read),
    );
    assert.equal(total(read), 4000, `every id checked once: ${JSON.stringify(read)}`);
    assert.equal(await captured(db), 4000);
  }));

test("a session's checks stop at its budget, each under what is left of it", () =>
  fixture(async ({ db }) => {
    const rows = 4 * sweepCheckIds;
    await sessions(db, [rows, 0]);
    const source = await digest(homeHistorySource);
    // Each check takes 1.1 s of the session's clock; the third is cut at the limit it was given.
    for (const cutThird of [false, true]) {
      const clock = { at: 0 };
      const limits: string[] = [];
      let checks = 0;
      const timed: HistoryDatabase = {
        query: async (text, values) => {
          if (text.startsWith("SELECT set_config('statement_timeout'"))
            limits.push(String(values![0]));
          if (text.startsWith("WITH s AS MATERIALIZED")) {
            clock.at += 1_100;
            if (cutThird && ++checks === 3) {
              await db.query("SELECT 1/0").catch(() => {});
              throw cancelled();
            }
          }
          return db.query(text, values);
        },
      };
      await db.query("BEGIN");
      const swept = await sweepLateCommits(
        timed,
        source,
        { sweepId: "0", sweepUpper: String(rows), forward: String(rows), backfillUpper: "0" },
        () => clock.at,
      );
      await db.query("ROLLBACK");
      assert.deepEqual(limits, [`${sweepCheckLimitMs}ms`, "1900ms", "800ms"]);
      assert.deepEqual(
        [swept.checked, swept.sweepId, swept.deferred],
        cutThird
          ? [2 * sweepCheckIds, String(2 * sweepCheckIds), false]
          : [3 * sweepCheckIds, String(3 * sweepCheckIds), false],
        "a cut under what the budget left is the budget's end, not a slow check",
      );
    }
  }));
