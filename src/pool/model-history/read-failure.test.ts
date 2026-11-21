import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlFailure } from "../json.ts";
import { watchHistoryRead } from "./read-failure.ts";

const failures = (calls: { arguments: unknown[] }[]) =>
  calls
    .filter((call) => call.arguments[0] === "POOL_USAGE_READ_FAILED")
    .map((call) => JSON.parse(String(call.arguments[1])) as Record<string, unknown>);

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

test("a read that fails before any statement names its failure from the error, without a statement", (t) => {
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
  assert.deepEqual(failures(errors.mock.calls), [
    { action: "poolOverview", status: 503, failure: "transport", elapsedMs: 1_234 },
  ]);
  assert.deepEqual(reported, ["poolOverview"]);
});

test("the first failed statement is the one named, and a failing reporter changes nothing", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  let clock = 0;
  const watch = watchHistoryRead("poolUsageSummary", "summary", () => clock);
  const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  await watch.diagnostics!.run("sql_statement", async () => (clock += 10), 1);
  await assert.rejects(
    watch.diagnostics!.run(
      "sql_statement",
      async () => {
        clock += 5_000;
        throw timeout;
      },
      2,
    ),
  );
  await assert.rejects(
    watch.diagnostics!.run(
      "sql_statement",
      async () => {
        throw new Error("current transaction is aborted");
      },
      3,
    ),
  );
  watch.answered(timeout, new Response(null, { status: 503 }), () => {
    throw new Error("reporter down");
  });
  assert.deepEqual(failures(errors.mock.calls), [
    {
      action: "poolUsageSummary",
      status: 503,
      failure: "statement_timeout",
      elapsedMs: 5_010,
      statement: 2,
      statementMs: 5_000,
    },
  ]);
});
