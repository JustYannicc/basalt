import assert from "node:assert/strict";
import { test } from "node:test";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { addHome, admin, captured, fixture } from "./capture-fixture.ts";

// A statement Postgres cancels at its own limit needs real PostgreSQL: CI's pool job provides it.
if (!admin)
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");

test("a check Postgres cancels at its own limit leaves the session's pages to land", () =>
  fixture(async ({ db }) => {
    // The pages pass 300 rows, and the next session sets the range the sweep checks after them.
    await addHome(db, 300);
    for (let session = 0; session < 2; session++)
      assert.equal((await captureHomeRequests(db)).state, "active");
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
  }));
