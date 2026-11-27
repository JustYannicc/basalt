import assert from "node:assert/strict";
import { test } from "node:test";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { sweepReachIds } from "../../src/pool/model-history/capture-sweep.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { historyBatchSize } from "../../src/pool/model-history/store.ts";
import { addHome, captured, fixture } from "./capture-fixture.ts";

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
