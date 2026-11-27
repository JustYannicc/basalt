import assert from "node:assert/strict";
import { test } from "node:test";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { sweepIdsPerSession, sweepReachIds } from "../../src/pool/model-history/capture-sweep.ts";
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

/**
 * Sessions through `db`, with the sweep's check made to run out its limit when `cut` says so: as
 * Postgres does, the statement fails and leaves the transaction aborted. Records the session's
 * statement limit where it stores its cursor.
 */
function cutChecks(
  db: HistoryDatabase,
  cut: () => boolean,
  limits: string[] = [],
): HistoryDatabase {
  return {
    query: async (text, values) => {
      if (text.startsWith("WITH s AS MATERIALIZED") && cut()) {
        await db.query("SELECT 1/0").catch(() => {});
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
          severity: "ERROR",
        });
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
    const cut = await captureHomeRequests(cutChecks(db, () => true));
    assert.ok(cut.state === "active");
    assert.equal(cut.fresh, 50, "the forward page landed");
    assert.equal(cut.swept, 0);
    assert.equal(cut.sweepDeferred, true);
    assert.equal(await captured(db), 350);
    assert.deepEqual(await sweepFields(db), pending, "the range is neither skipped nor finished");
    const limits: string[] = [];
    const after = [];
    for (let session = 0; session < 3; session++) {
      const result = await captureHomeRequests(cutChecks(db, () => false, limits));
      assert.ok(result.state === "active");
      after.push(result.swept);
    }
    assert.deepEqual(after, [300, 50, 0], "every id checked once after the cut");
    assert.ok(
      limits.every((limit) => limit === "5s"),
      `the session's own limit is back after its check: ${JSON.stringify(limits)}`,
    );
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
