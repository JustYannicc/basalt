import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolUsageSummaryResult } from "../../apps/pool/usage-overview-contract.ts";
import { withHistoryDatabase, type HistoryDatabaseClient } from "./model-history/database.ts";
import { poolUsageSummary } from "./model-history/summary.ts";

const pool = "fixture-pool";

/** Postgres cancels one statement with SQLSTATE 57014 and keeps the session; pg rejects that query. */
function session(cancel: RegExp, log: string[], state = { destroys: 0, ends: 0 }) {
  let aborted = false;
  const client: HistoryDatabaseClient = {
    async connect() {},
    async query(text) {
      log.push(text);
      if (text.startsWith("ROLLBACK TO SAVEPOINT")) aborted = false;
      else if (aborted && !text.startsWith("ROLLBACK"))
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      if (cancel.test(text)) {
        aborted = true;
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {
      state.ends++;
    },
    on() {},
    connection: {
      stream: {
        destroy() {
          state.destroys++;
        },
      },
    },
  };
  return { client, state };
}

test("a statement Postgres cancels inside the incidents savepoint degrades incidents and keeps the summary", async () => {
  const log: string[] = [];
  const { client, state } = session(/WITH ranges\(ordinal,from_at,to_at\)/, log);
  const result: PoolUsageSummaryResult = await withHistoryDatabase(
    "postgres://fixture",
    (db) =>
      poolUsageSummary(db, {
        pool,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        authority: { canManage: true, mappingProven: true, accounts: [] },
      }),
    { createClient: async () => client },
  );
  assert.equal(result.incidents.status, "unavailable");
  assert.ok(log.includes("ROLLBACK TO SAVEPOINT summary_incidents"));
  assert.equal(log.at(-1), "COMMIT");
  assert.deepEqual(state, { destroys: 0, ends: 1 });
});
