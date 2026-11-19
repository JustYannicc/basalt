import assert from "node:assert/strict";
import { test } from "node:test";
import { readPoolReliabilitySlo } from "./model-history/reliability-slo.ts";
import { reliabilityFailure, reliabilityStep } from "./model-history/reliability-read-failure.ts";
import type { HistoryDatabase } from "./model-history/schema.ts";

const now = Date.parse("2026-11-18T11:51:43Z");

/** Answers every statement of the read the way a healthy, idle pool would. */
function idlePool(fail?: (text: string) => unknown) {
  const statements: string[] = [];
  const db: HistoryDatabase = {
    query: async (text) => {
      statements.push(text);
      const failure = fail?.(text);
      if (failure) throw failure;
      if (text.includes("FROM selected")) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            ready: true,
            backfill_complete: true,
            forward_id: "0",
            captured_at: new Date(now).toISOString(),
            lagging: false,
            pending: false,
            unavailable_finish: false,
            unmatched_home: false,
          },
        ],
        rowCount: 1,
      };
    },
  };
  return { db, statements };
}

test("every statement of the reliability read has a closed step name", async () => {
  const { db, statements } = idlePool();
  const slo = await readPoolReliabilitySlo(db, "fixture", now);
  assert.equal(slo.state, "no_traffic");
  assert.deepEqual(
    statements.filter((text) => reliabilityStep(text) === "other"),
    [],
    "a new statement needs its own step name",
  );
  assert.ok(statements.some((text) => reliabilityStep(text) === "terminal_evidence"));
});

test("a timed-out statement is reported with its step and SQLSTATE, and the read still fails", async (t) => {
  const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  const { db, statements } = idlePool((text) =>
    text.includes("AS unmatched_home") ? timeout : undefined,
  );
  const errors = t.mock.method(console, "error", () => {});
  await assert.rejects(readPoolReliabilitySlo(db, "fixture", now), (error) => error === timeout);
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [
      [
        "POOL_REQUEST_RELIABILITY_READ_FAILED",
        { step: "terminal_evidence", failure: "statement_timeout", sqlstate: "57014" },
      ],
    ],
  );
  assert.ok(statements.at(-1)?.startsWith("ROLLBACK"), "the owned transaction is rolled back");
  assert.doesNotMatch(JSON.stringify(errors.mock.calls), /canceling statement/);
});

test("session failures map to closed causes and never carry a driver message", () => {
  assert.deepEqual(reliabilityFailure(new Error("Model request history is disabled")), {
    failure: "history_disabled",
  });
  assert.deepEqual(reliabilityFailure(new Error("Model history database deadline exceeded")), {
    failure: "total_deadline",
  });
  assert.deepEqual(reliabilityFailure(Object.assign(new Error("x"), { code: "42501" })), {
    failure: "sql_error",
    sqlstate: "42501",
  });
  assert.deepEqual(reliabilityFailure(new Error("password authentication failed for user x")), {
    failure: "unknown",
  });
  assert.deepEqual(reliabilityFailure(Object.assign(new Error("x"), { code: "not a state" })), {
    failure: "unknown",
  });
});
