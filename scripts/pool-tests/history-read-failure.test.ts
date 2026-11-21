import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlFailure } from "../../src/pool/json.ts";
import { watchHistoryRead } from "../../src/pool/model-history/read-failure.ts";
import { HistoryTimeoutFailure } from "../../src/pool/model-history/series-deadline.ts";

const failures = (calls: { arguments: unknown[] }[]) =>
  calls
    .filter((call) => call.arguments[0] === "POOL_USAGE_READ_FAILED")
    .map((call) => JSON.parse(String(call.arguments[1])) as Record<string, unknown>);
const statementTimeout = () =>
  Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

test("a refused or invalid read is not a failed read", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const reported: string[] = [];
  const watch = watchHistoryRead("poolUsageSummary", "summary");
  for (const status of [400, 401, 403, 404])
    watch.answered(
      new ControlFailure(status, "unauthorized", "refused"),
      new Response(null, { status }),
      (action) => reported.push(action),
    );
  assert.deepEqual(failures(errors.mock.calls), []);
  assert.deepEqual(reported, []);
});

test("a read that fails before any statement names its cause, also through a deadline error", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  let clock = 0;
  const reported: string[] = [];
  const watch = watchHistoryRead("poolOverview", undefined, () => clock);
  clock = 1_234;
  watch.answered(
    Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
    new Response(null, { status: 503 }),
    (action) => reported.push(action),
  );
  watch.answered(
    new Error("Model history database deadline exceeded", {
      cause: new HistoryTimeoutFailure("connect_timeout"),
    }),
    new Response(null, { status: 503 }),
  );
  assert.deepEqual(failures(errors.mock.calls), [
    { action: "poolOverview", status: 503, failure: "transport", elapsedMs: 1_234 },
    { action: "poolOverview", status: 503, failure: "connect_timeout", elapsedMs: 1_234 },
  ]);
  assert.deepEqual(reported, ["poolOverview"]);
});

test("the failed statement is named by its step, and the rollback after it does not hide it", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const info = t.mock.method(console, "info", () => {});
  let clock = 0;
  const watch = watchHistoryRead("poolUsageSummary", "summary", () => clock);
  const run = watch.diagnostics!.run;
  watch.mark("targets");
  await run("sql_statement", async () => (clock += 10), 3);
  watch.mark("capture");
  await assert.rejects(
    run(
      "sql_statement",
      async () => {
        clock += 5_000;
        throw statementTimeout();
      },
      7,
    ),
  );
  watch.mark("rollback");
  await run("sql_statement", async () => (clock += 1), 8);
  watch.answered(statementTimeout(), new Response(null, { status: 503 }), () => {
    throw new Error("reporter down");
  });
  assert.deepEqual(failures(errors.mock.calls), [
    {
      action: "poolUsageSummary",
      status: 503,
      failure: "statement_timeout",
      elapsedMs: 5_011,
      statement: 7,
      statementMs: 5_000,
      step: "capture",
    },
  ]);
  const phases = info.mock.calls.map((call) => call.arguments[1] as Record<string, unknown>);
  assert.deepEqual(
    phases.map((phase) => phase.step),
    ["targets", "capture", "rollback"],
  );
});

test("a statement that failed inside a recovered savepoint never takes the blame", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const watch = watchHistoryRead("poolUsageSummary", "summary", () => 0);
  const run = watch.diagnostics!.run;
  watch.mark("incidents");
  await assert.rejects(
    run(
      "sql_statement",
      async () => {
        throw statementTimeout();
      },
      12,
    ),
  );
  // ROLLBACK TO SAVEPOINT succeeds and the summary goes on, then fails for a reason of its own.
  await run("sql_statement", async () => undefined, 13);
  watch.answered(
    new Error("Usage summary exceeds its bounded response"),
    new Response(null, { status: 503 }),
  );
  assert.deepEqual(failures(errors.mock.calls), [
    { action: "poolUsageSummary", status: 503, failure: "unknown", elapsedMs: 0 },
  ]);
});
