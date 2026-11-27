import assert from "node:assert/strict";
import { test } from "node:test";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { HistoryConflict } from "../../src/pool/model-history/store.ts";
import {
  admin,
  addHome,
  burst,
  captured,
  cursor,
  fixture,
  passes,
  saveRetained,
  steady,
} from "./capture-fixture.ts";

// Two sessions and a six-hour replay need real PostgreSQL: CI's pool job provides it.
if (!admin)
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");

test("a conflicting request another writer commits while the page waits on it stops the page", () =>
  fixture(async ({ db, second }) => {
    await addHome(db, 3);
    // Uncommitted when the page's write starts, so that statement's snapshot cannot see it.
    await second!.query("BEGIN");
    await saveRetained(second!, { source: "a".repeat(64) });
    const page = captureHomeRequests(db).then(
      () => assert.fail("the page must not commit over another writer's request"),
      (error: unknown) => error,
    );
    // The page's insert now waits for that row; commit it inside the page's 500 ms lock limit.
    // pg_locks is read live; pg_stat_activity would stay fixed inside this open transaction.
    for (let tries = 0; tries < 2_000; tries++) {
      const waiting = await second!.query(
        `SELECT 1 FROM pg_locks WHERE NOT granted AND locktype='transactionid'
            AND pid <> pg_backend_pid()`,
      );
      if (waiting.rows.length) break;
    }
    await second!.query("COMMIT");
    assert.ok((await page) instanceof HistoryConflict);
    assert.equal(await cursor(db), "0");
  }));

test("six hours of that envelope, a burst each hour, drain pass by pass", () =>
  fixture(async ({ db }) => {
    const arrivals = Array.from({ length: 6 * 12 }, (_, index) =>
      index % 12 === 0 ? burst : steady,
    );
    await passes(db, arrivals);
    assert.equal(
      await captured(db),
      arrivals.reduce((sum, count) => sum + count, 0),
    );
  }));
