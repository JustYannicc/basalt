import assert from "node:assert/strict";
import { test } from "node:test";
import { withHistoryDatabase } from "./model-history/database.ts";
import { readPoolReliabilitySlo } from "./model-history/reliability-slo.ts";
import { reliabilityFailure, reliabilityStep } from "./model-history/reliability-read-failure.ts";
import { readReliabilityInSession } from "./model-history/reliability-session.ts";
import type { HistoryDatabaseClient } from "./model-history/database.ts";

const now = Date.parse("2026-11-18T12:00:00Z");

/** A database client that answers every statement the way a healthy, idle pool would. */
function idlePool(fail?: (text: string) => unknown) {
  const statements: string[] = [];
  const client: HistoryDatabaseClient = {
    connect: async () => {},
    end: async () => {},
    on: () => {},
    connection: { stream: { destroy: () => {} } },
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
  const read = () =>
    withHistoryDatabase("postgres://fixture", (db) => readPoolReliabilitySlo(db, "fixture", now), {
      createClient: async () => client,
    });
  return { read, statements, client };
}

/** The read's own session over an idle pool whose connect or close misbehaves. */
async function sessionRead(
  change: Partial<Pick<HistoryDatabaseClient, "connect" | "end">>,
  fail?: (text: string) => unknown,
  signal?: AbortSignal,
) {
  const { client } = idlePool(fail);
  const failure = await readReliabilityInSession("postgres://fixture", "fixture", now, {
    createClient: async () => ({ ...client, ...change }),
    ...(signal ? { signal } : {}),
  }).then(
    () => assert.fail("the session should fail"),
    (error: unknown) => error,
  );
  assert.match(String(failure), /^Error: Model history reliability session failed$/);
  return failure;
}

const failureLines = (errors: { mock: { calls: { arguments: unknown[] }[] } }) =>
  errors.mock.calls
    .filter((call) => call.arguments[0] === "POOL_REQUEST_RELIABILITY_READ_FAILED")
    .map((call) => call.arguments[1]);

test("every statement of the reliability read has its own step name", async () => {
  const { read, statements } = idlePool();
  assert.equal((await read()).state, "no_traffic");
  assert.deepEqual(statements.map(reliabilityStep), [
    "begin",
    "timeout_setting",
    "terminal_tables",
    "terminal_marker",
    "traffic_table",
    "windows",
    "cursor",
    "usage_table",
    "lagging",
    "terminal_pending",
    "terminal_evidence",
    "commit",
  ]);
});

test("a statement that times out is reported with its step, and the read still fails", async (t) => {
  const { read, statements } = idlePool((text) =>
    text.includes("AS unmatched_home")
      ? Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
      : undefined,
  );
  const errors = t.mock.method(console, "error", () => {});
  await assert.rejects(read(), /^Error: Model history database deadline exceeded$/);
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [
      [
        "POOL_REQUEST_RELIABILITY_READ_FAILED",
        { read: "standalone", step: "terminal_evidence", failure: "statement_timeout" },
      ],
    ],
    "one line for the failing statement",
  );
  // The session stops at its first timeout; closing the connection rolls the transaction back.
  assert.equal(reliabilityStep(statements.at(-1) ?? ""), "terminal_evidence");
  assert.doesNotMatch(JSON.stringify(errors.mock.calls), /canceling statement|fixture/);
});

test("a session failing outside its statements logs where and why, and its caller gets nothing private", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  await sessionRead({
    connect: async () => {
      throw new Error("Connection terminated due to connection timeout");
    },
  });
  // Every statement succeeded; the connection then never closed and the session was stopped.
  const stop = new AbortController();
  await sessionRead(
    {
      end: () => {
        stop.abort();
        return new Promise<void>(() => {});
      },
    },
    undefined,
    stop.signal,
  );
  assert.deepEqual(failureLines(errors), [
    { read: "standalone", step: "session", phase: "connect", failure: "connect_timeout" },
    { read: "standalone", step: "session", phase: "close", failure: "cancelled" },
  ]);
  assert.doesNotMatch(JSON.stringify(errors.mock.calls), /Connection terminated|fixture/);
});

test("a statement timeout logs its step and then the session's statements phase", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  await sessionRead({}, (text) =>
    text.includes("AS unmatched_home")
      ? Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
      : undefined,
  );
  assert.deepEqual(failureLines(errors), [
    { read: "standalone", step: "terminal_evidence", failure: "statement_timeout" },
    { read: "standalone", step: "session", phase: "statements", failure: "statement_timeout" },
  ]);
});

test("a database error keeps its SQLSTATE, and session failures map to closed causes", () => {
  assert.deepEqual(
    reliabilityFailure(Object.assign(new Error("x"), { code: "42501", severity: "ERROR" })),
    { failure: "database_error", sqlstate: "42501" },
  );
  assert.equal(
    reliabilityFailure(Object.assign(new Error("x"), { code: "EPIPE" })).sqlstate,
    undefined,
    "a socket code is not an SQLSTATE",
  );
  assert.deepEqual(reliabilityFailure(new Error("Model request history is disabled")), {
    failure: "history_disabled",
  });
  assert.deepEqual(reliabilityFailure(new Error("Model history database deadline exceeded")), {
    failure: "history_deadline",
  });
  assert.deepEqual(reliabilityFailure(new Error("password authentication failed for user x")), {
    failure: "unknown",
  });
  assert.deepEqual(reliabilityFailure(Object.assign(new Error("x"), { code: "not a state" })), {
    failure: "unknown",
  });
});
