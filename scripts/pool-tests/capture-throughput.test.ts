import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import {
  captureSessionMs,
  captureSessionsPerPass,
  runModelHistoryPass,
} from "../../src/pool/model-history/pass.ts";
import { HistoryConflict, historyBatchSize } from "../../src/pool/model-history/store.ts";
import type { ReportingProgress } from "../../src/pool/reporting.ts";
import {
  addHome,
  burst,
  captured,
  cursor,
  fixture,
  head,
  onRoundTrips,
  pageWrite,
  passes,
  saveRetained,
  steady,
  watched,
} from "./capture-fixture.ts";

test("a session cut between pages keeps every page it committed, and the next one continues there", () =>
  fixture(async ({ db }) => {
    await addHome(db, 2 * historyBatchSize + 50);
    let writes = 0;
    const cut = new Error("controlled connection loss before the second page's write");
    const session = watched(db, (sql) => {
      if (pageWrite(sql) && ++writes === 2) throw cut;
    });
    await assert.rejects(captureHomeRequests(session), (error) => error === cut);
    assert.equal(await cursor(db), String(historyBatchSize));
    assert.equal(await captured(db), historyBatchSize);
    const next = await captureHomeRequests(db);
    assert.equal(next.state === "active" && next.caughtUp, true);
    assert.equal(await cursor(db), await head(db));
    assert.equal(await captured(db), 2 * historyBatchSize + 50);
  }));

test("a draining handover waits for at most the page in flight", () =>
  fixture(async ({ db }) => {
    await addHome(db, 2 * historyBatchSize + 50);
    let writes = 0;
    const session = watched(db, (sql) => {
      if (pageWrite(sql)) writes++;
    });
    // The handover starts while the first page is being written.
    const result = await captureHomeRequests(session, { stop: () => writes > 0 });
    assert.equal(writes, 1);
    assert.equal(result.state === "active" && result.caughtUp, false);
    assert.equal(await cursor(db), String(historyBatchSize));
  }));

for (const [branch, change] of [
  ["another source", { source: "a".repeat(64) }],
  ["another source record", { record: "b".repeat(64) }],
] as const)
  test(`a retained request with the same id and ${branch} stops the page and moves no cursor`, () =>
    fixture(async ({ db }) => {
      await addHome(db, 3);
      await saveRetained(db, change);
      await assert.rejects(captureHomeRequests(db), (error) => error instanceof HistoryConflict);
      assert.equal(await cursor(db), "0");
      assert.equal(await captured(db), 1, "nothing of the page is written");
    }));

test("a retained request with the same identity keeps its original pool and the page goes on", () =>
  fixture(async ({ db }) => {
    await addHome(db, 3);
    await saveRetained(db, { pool: "f".repeat(16) });
    const result = await captureHomeRequests(db);
    assert.equal(result.state === "active" && result.inserted, 2);
    assert.equal(await cursor(db), "3");
    const saved = (
      await db.query("SELECT pool FROM basalt_model_requests WHERE source_record=$1", [
        await digest(JSON.stringify(["usage", "1"])),
      ])
    ).rows;
    assert.deepEqual(saved, [{ pool: "f".repeat(16) }]);
  }));

test("a steady rate above one person's measured peak is captured each pass, with no backlog", () =>
  fixture(async ({ db }) => {
    await passes(
      db,
      Array.from({ length: 12 }, () => steady),
    );
    assert.equal(await captured(db), 12 * steady);
  }));

test("five minutes at one person's measured one-minute peak drain within their own pass", () =>
  fixture(async ({ db }) => {
    await passes(db, [burst]);
    assert.equal(await captured(db), burst);
  }));

test("a pass still behind after its sessions reports partial and keeps what it committed", () =>
  fixture(async ({ db }) => {
    // More pages than both sessions take at one second a round trip, five round trips a page.
    const pass = onRoundTrips(db, 1_000);
    const pages = Math.ceil((captureSessionsPerPass * captureSessionMs) / 5_000) + 4;
    await addHome(db, pages * historyBatchSize);
    const progress: ReportingProgress = { rows: null };
    await pass(progress);
    assert.equal(progress.outcome, "partial");
    const split = progress.split!;
    assert.ok(split.pages! > 0 && split.pages! < pages);
    assert.equal(split.newRows, Number(await cursor(db)));
    assert.equal(await captured(db), Number(await cursor(db)));
  }));

test("a handover that drains during a pass ends it after the page in flight, without the reliability read", () =>
  fixture(async ({ db }) => {
    await addHome(db, 3 * historyBatchSize);
    let writes = 0,
      reliability = 0;
    const session = watched(db, (sql) => {
      if (pageWrite(sql)) writes++;
    });
    const progress: ReportingProgress = { rows: null };
    await runModelHistoryPass(
      {
        session: (work) => work(session),
        publish: async () => {},
        reliability: async () => void reliability++,
        rollup: async () => {},
        hours: async () => {},
        stopped: () => writes > 0,
      },
      progress,
    );
    assert.deepEqual({ writes, reliability }, { writes: 1, reliability: 0 });
    assert.equal(progress.outcome, "partial");
    assert.equal(await cursor(db), String(historyBatchSize));
  }));

test("a handover that drained before the pass opens no session and leaves it incomplete", () =>
  fixture(async ({ db }) => {
    let sessions = 0;
    const progress: ReportingProgress = { rows: null };
    await runModelHistoryPass(
      {
        session: async (work) => {
          sessions++;
          return work(db);
        },
        publish: async () => {},
        rollup: async () => {},
        hours: async () => {},
        stopped: () => true,
      },
      progress,
    );
    assert.equal(sessions, 0);
    assert.equal(progress.outcome, "incomplete");
  }));

test("pages that keep failing leave the capture time where it was, so capture goes stale", () =>
  fixture(async ({ db }) => {
    await addHome(db, 3);
    await captureHomeRequests(db);
    const at = async () =>
      String(
        (await db.query("SELECT updated_at::text AS at FROM basalt_model_history_cursor")).rows[0]!
          .at,
      );
    const before = await at();
    await addHome(db, 3);
    // Row 4's id is retained under another source: every page that reaches it conflicts.
    await saveRetained(db, { source: "a".repeat(64) }, 4);
    for (let pass = 0; pass < 2; pass++)
      await assert.rejects(captureHomeRequests(db), (error) => error instanceof HistoryConflict);
    assert.equal(await at(), before);
    assert.equal(await cursor(db), "3");
  }));
