import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDatabaseBackends, type DatabaseClient } from "./verify-database-budget.ts";
import { backendCountSql, backendVisibilitySql } from "./database-budget-verification.ts";
import {
  DatabaseBudgetFailure,
  safeDatabaseError,
  type BudgetReceipt,
} from "./database-budget-receipt.ts";

function fixture(
  options: { connect?: string; sql?: string; visible?: boolean; connections?: number } = {},
) {
  const actions: string[] = [];
  let receipt: BudgetReceipt | undefined;
  const privateError = (code: string) =>
    Object.assign(new Error("password secret user@private-host.invalid"), { code });
  const client: DatabaseClient = {
    on() {},
    async connect() {
      actions.push("connect");
      if (options.connect) throw privateError(options.connect);
    },
    connection: {
      stream: {
        destroy() {
          actions.push("destroy");
        },
      },
    },
    async end() {
      actions.push("end");
    },
    async query(sql, values) {
      actions.push(sql);
      if (sql === backendVisibilitySql) return { rows: [{ visible: options.visible ?? true }] };
      if (sql === backendCountSql) {
        assert.deepEqual(values, [["runtime"]]);
        if (options.sql) throw privateError(options.sql);
        return { rows: [{ database: "pool", connections: options.connections ?? 5 }] };
      }
      return { rows: [] };
    },
  };
  const run = () =>
    checkDatabaseBackends({
      adminUrl: "postgres://admin:secret@private-host.invalid/pool",
      runtimeLogins: ["runtime.branch"],
      databases: ["pool"],
      client,
      deadlineMs: 0,
      now: () => 0,
      retain: async (value) => {
        receipt = value;
        actions.push("retain");
      },
    });
  return { run, actions, receipt: () => receipt };
}
for (const [input, outcome, code] of [
  [{ connect: "ECONNREFUSED" }, "connect-error", "ECONNREFUSED"],
  [{ connect: "53300" }, "connect-error", "53300"],
  [{ sql: "42501" }, "sql-error", "42501"],
  [{ sql: "53300" }, "sql-error", "53300"],
  [{ sql: "57014" }, "statement-timeout", "57014"],
  [{ visible: false }, "incomplete-visibility", undefined],
  [{ connections: 6 }, "over-budget-deadline", undefined],
] as const) {
  test(`${outcome} ${code ?? ""} retains safe diagnostics before guaranteed teardown`, async () => {
    const f = fixture(input);
    await assert.rejects(f.run(), (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.equal(error.receipt.outcome, outcome);
      assert.equal(error.receipt.code, code);
      assert.doesNotMatch(error.message, /secret|private-host|runtime.branch|admin/);
      return true;
    });
    assert.deepEqual(f.actions.slice(-3), ["retain", "destroy", "end"]);
    assert.equal(
      f.receipt()?.counts,
      outcome === "over-budget-deadline" ? f.receipt()?.counts : null,
    );
  });
}
test("five succeeds, keeps one bounded client and retains before cleanup", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), [{ database: "pool", connections: 5 }]);
  assert.equal(f.actions.filter((action) => action === "connect").length, 1);
  assert.ok(f.actions.includes("BEGIN TRANSACTION READ ONLY"));
  assert.ok(f.actions.includes("SET LOCAL statement_timeout = '4s'"));
  assert.deepEqual(f.actions.slice(-3), ["retain", "destroy", "end"]);
});
test("abort during connect remains abort and releases the connection", async () => {
  const controller = new AbortController();
  const f = fixture();
  const client: DatabaseClient = {
    on() {},
    connect: () => new Promise(() => {}),
    async end() {
      f.actions.push("end");
    },
    query: async () => ({ rows: [] }),
    connection: {
      stream: {
        destroy() {
          f.actions.push("destroy");
        },
      },
    },
  };
  const run = checkDatabaseBackends({
    adminUrl: "fixture",
    runtimeLogins: ["runtime"],
    databases: ["pool"],
    client,
    signal: controller.signal,
    retain: async () => {
      f.actions.push("retain");
    },
  });
  controller.abort();
  await assert.rejects(
    run,
    (error) => error instanceof DatabaseBudgetFailure && error.receipt.outcome === "abort",
  );
  assert.deepEqual(f.actions.slice(-3), ["retain", "destroy", "end"]);
});

test("unrecognized driver codes and raw messages never enter structured causes", () => {
  assert.deepEqual(
    safeDatabaseError(
      Object.assign(new Error("password=user@private-host"), { code: "TOKEN" }),
      "read",
    ),
    { outcome: "sql-error" },
  );
});

test("a stalled end is bounded by one second after retaining the outcome", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ending!: () => void;
  const endStarted = new Promise<void>((resolve) => {
    ending = resolve;
  });
  const actions: string[] = [];
  const client: DatabaseClient = {
    on() {},
    async connect() {},
    connection: {
      stream: {
        destroy() {
          actions.push("destroy");
        },
      },
    },
    end() {
      actions.push("end");
      ending();
      return new Promise(() => {});
    },
    async query(sql) {
      return {
        rows:
          sql === backendVisibilitySql
            ? [{ visible: true }]
            : sql === backendCountSql
              ? [{ database: "pool", connections: 5 }]
              : [],
      };
    },
  };
  const work = checkDatabaseBackends({
    adminUrl: "fixture",
    runtimeLogins: ["runtime"],
    databases: ["pool"],
    client,
    deadlineMs: 0,
    now: () => 0,
    retain: async () => {
      actions.push("retain");
    },
  });
  await endStarted;
  assert.deepEqual(actions, ["retain", "destroy", "end"]);
  // The timer is installed after end() returns its pending promise.
  t.mock.timers.tick(1000);
  assert.deepEqual(await work, [{ database: "pool", connections: 5 }]);
});
