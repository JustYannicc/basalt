import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlFailure, failureResponse } from "../../src/pool/json.ts";
import {
  withHistoryDatabase,
  type HistoryDatabaseClient,
} from "../../src/pool/model-history/database.ts";
import {
  HistoryDeadline,
  HistoryTimeoutFailure,
} from "../../src/pool/model-history/series-deadline.ts";
import {
  historySeriesDiagnostics,
  historySeriesFailure,
  type HistorySeriesObservation,
} from "../../src/pool/model-history/series-diagnostics.ts";
import {
  handleUsageSeries,
  poolUsageSeriesPath,
} from "../../src/pool/model-history/series-http.ts";
import { signEnvelope } from "../../src/pool/token.ts";

const privateSentinel = "private-SQL-user-pool-model-token-URL";

function clientFixture(
  query: HistoryDatabaseClient["query"] = async () => ({ rows: [], rowCount: 0 }),
) {
  const closed = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const state = { connects: 0, destroys: 0, ends: 0, queries: 0 };
  const client: HistoryDatabaseClient = {
    async connect() {
      state.connects++;
    },
    async query(text, values) {
      state.queries++;
      return query(text, values);
    },
    async end() {
      state.ends++;
      ended.resolve();
    },
    on() {},
    connection: {
      stream: {
        destroy() {
          state.destroys++;
          closed.resolve();
        },
      },
    },
  };
  return { client, state, closed, ended };
}

test("History phase diagnostics retain only closed failure classes and timings", async () => {
  const cases = [
    [{ code: "57014", message: privateSentinel }, "statement_timeout"],
    [{ code: "55P03", detail: privateSentinel }, "lock_timeout"],
    [new Error("Query read timeout"), "query_timeout"],
    [new Error("Connection terminated due to connection timeout"), "connect_timeout"],
    [{ code: "42P01", query: privateSentinel }, "database_error"],
    [{ code: "ECONNRESET", url: privateSentinel }, "transport"],
    [new ControlFailure(401, "unauthorized", privateSentinel), "unauthorized"],
    [{ code: privateSentinel, token: privateSentinel }, "unknown"],
  ] as const;
  const logs: HistorySeriesObservation[] = [];
  let now = 0;
  const diagnostics = historySeriesDiagnostics(
    (entry) => logs.push(entry),
    () => now,
  );
  for (const [error, expected] of cases) {
    assert.equal(historySeriesFailure(error), expected);
    await assert.rejects(
      diagnostics.run(
        "sql_statement",
        async () => {
          now += 17;
          throw error;
        },
        logs.length + 1,
      ),
      (thrown: unknown) => thrown === error,
    );
    assert.deepEqual(logs.at(-1), {
      phase: "sql_statement",
      status: "error",
      elapsedMs: 17,
      failure: expected,
      statement: logs.length,
    });
  }
  assert.doesNotMatch(JSON.stringify(logs), /private-|57014|55P03|42P01|ECONNRESET/);
  assert.equal(await diagnostics.run("price_callback", async () => "result"), "result");
  assert.deepEqual(logs.at(-1), { phase: "price_callback", status: "ok", elapsedMs: 0 });
});

test("a broken diagnostic reporter cannot change success or the original refusal", async (t) => {
  t.mock.method(console, "info", () => {
    throw new Error(privateSentinel);
  });
  const diagnostics = historySeriesDiagnostics();
  assert.equal(await diagnostics.run("database_connect", async () => 7), 7);
  const refusal = new ControlFailure(
    401,
    "unauthorized",
    "A valid host usage assertion is required.",
  );
  await assert.rejects(
    diagnostics.run("signed_envelope_validation", async () => {
      throw refusal;
    }),
    (error: unknown) => error === refusal,
  );
});

test("slow SQL fails at five seconds, closes its socket, blocks late queries and recovers", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>();
  const f = clientFixture(async () => {
    entered.resolve();
    return pending.promise;
  });
  // pg may reject after the timeout response has already won the race.
  void f.closed.promise.then(() => pending.reject(new Error(privateSentinel)));
  const logs: HistorySeriesObservation[] = [];
  const diagnostics = historySeriesDiagnostics(
    (entry) => logs.push(entry),
    () => Date.now(),
  );
  let settled = false;
  const response = withHistoryDatabase(
    privateSentinel,
    async (db) => {
      try {
        return await db.query(`SELECT ${privateSentinel}`, [privateSentinel]);
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
      }
    },
    {
      totalTimeoutMs: 5_000,
      timeoutFailure: "history",
      diagnostics,
      createClient: async () => f.client,
    },
  )
    .then(() => {
      throw new Error("The slow SQL must time out");
    }, failureResponse)
    .then((value) => {
      settled = true;
      return value;
    });
  await entered.promise;
  t.mock.timers.tick(4_999);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const timeout = await response;
  assert.equal(timeout.status, 504);
  assert.deepEqual(await timeout.json(), {
    error: "history_timeout",
    message: "History is taking too long. Try again.",
  });
  await f.ended.promise;
  assert.deepEqual(f.state, { connects: 1, destroys: 1, ends: 1, queries: 1 });
  assert.deepEqual(logs, [
    { phase: "database_connect", status: "ok", elapsedMs: 0 },
    {
      phase: "sql_statement",
      status: "error",
      elapsedMs: 5_000,
      failure: "total_deadline",
      statement: 1,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private-/);

  const healthy = clientFixture(async () => ({ rows: [{ recovered: true }], rowCount: 1 }));
  const recovered = await withHistoryDatabase(privateSentinel, (db) => db.query("SELECT 1"), {
    totalTimeoutMs: 5_000,
    timeoutFailure: "history",
    diagnostics,
    createClient: async () => healthy.client,
  });
  assert.deepEqual(recovered.rows, [{ recovered: true }]);
  t.mock.timers.tick(20_000);
  assert.deepEqual(healthy.state, { connects: 1, destroys: 0, ends: 1, queries: 1 });
});

test("SQL timeouts expose History 504 only with explicit policy and preserve default caller privacy", async () => {
  for (const timeoutFailure of [undefined, "history"] as const) {
    // Postgres answered a cancelled statement, so its session closes normally; only a timeout on
    // this side leaves the socket unknown and destroys it.
    for (const [error, destroys] of [
      [Object.assign(new Error(privateSentinel), { code: "57014" }), 0],
      [Object.assign(new Error(privateSentinel), { code: "55P03" }), 0],
      [new Error("Query read timeout"), 1],
    ] as const) {
      const f = clientFixture(async () => {
        throw error;
      });
      const response = await withHistoryDatabase(
        privateSentinel,
        (db) => db.query(privateSentinel),
        {
          timeoutFailure,
          diagnostics: historySeriesDiagnostics(() => {}),
          createClient: async () => f.client,
        },
      ).then(() => {
        throw new Error("Expected timeout");
      }, failureResponse);
      assert.equal(response.status, timeoutFailure === "history" ? 504 : 503);
      const body = await response.json();
      assert.deepEqual(
        body,
        timeoutFailure === "history"
          ? { error: "history_timeout", message: "History is taking too long. Try again." }
          : {
              error: "backend_unavailable",
              message: "The pool backend is unavailable. Try again later.",
            },
      );
      assert.doesNotMatch(JSON.stringify(body), /private-|57014|55P03|Query read timeout/);
      await f.ended.promise;
      assert.equal(f.state.destroys, destroys);
      assert.equal(f.state.ends, 1);
    }
  }
});

test("default database callers retain the twenty-second deadline and generic 503", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = Promise.withResolvers<void>();
  const f = clientFixture(async () => {
    entered.resolve();
    return new Promise(() => {});
  });
  let settled = false;
  const response = withHistoryDatabase(privateSentinel, (db) => db.query(privateSentinel), {
    createClient: async () => f.client,
  })
    .then(() => {
      throw new Error("Expected timeout");
    }, failureResponse)
    .then((value) => {
      settled = true;
      return value;
    });
  await entered.promise;
  t.mock.timers.tick(19_999);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const result = await response;
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), {
    error: "backend_unavailable",
    message: "The pool backend is unavailable. Try again later.",
  });
  await f.ended.promise;
  assert.equal(f.state.destroys, 1);
});

test("the timeout response does not wait for stalled driver shutdown and absorbs its late rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = Promise.withResolvers<void>();
  const shutdownEntered = Promise.withResolvers<void>();
  const shutdownEnded = Promise.withResolvers<void>();
  const shutdown = Promise.withResolvers<void>();
  const f = clientFixture(async () => {
    entered.resolve();
    return new Promise(() => {});
  });
  f.client.end = async () => {
    shutdownEntered.resolve();
    try {
      await shutdown.promise;
    } finally {
      shutdownEnded.resolve();
    }
  };
  const response = withHistoryDatabase(privateSentinel, (db) => db.query(privateSentinel), {
    totalTimeoutMs: 5_000,
    timeoutFailure: "history",
    createClient: async () => f.client,
  }).then(() => {
    throw new Error("Expected timeout");
  }, failureResponse);
  await entered.promise;
  t.mock.timers.tick(5_000);
  assert.equal((await response).status, 504);
  await shutdownEntered.promise;
  assert.equal(f.state.destroys, 1);
  shutdown.reject(new Error(privateSentinel));
  await shutdownEnded.promise;
});

test("cancellation closes the owned session and a cancelled connect never starts SQL", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const f = clientFixture();
  f.client.connect = async () => {
    entered.resolve();
    await held.promise;
  };
  const read = withHistoryDatabase(privateSentinel, (db) => db.query(privateSentinel), {
    timeoutFailure: "history",
    signal: controller.signal,
    createClient: async () => f.client,
  });
  const rejected = assert.rejects(
    read,
    (error: unknown) => error instanceof HistoryTimeoutFailure && error.reason === "cancelled",
  );
  await entered.promise;
  controller.abort(privateSentinel);
  await rejected;
  held.resolve();
  await f.ended.promise;
  assert.equal(f.state.destroys, 1);
  assert.equal(f.state.queries, 0);
});

test("the shared series deadline reports total expiry while cancelling nested database work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const outer = new HistoryDeadline(5_000);
  const entered = Promise.withResolvers<void>();
  const f = clientFixture(async () => {
    entered.resolve();
    return new Promise(() => {});
  });
  const read = outer.run(() =>
    withHistoryDatabase(privateSentinel, (db) => db.query(privateSentinel), {
      totalTimeoutMs: 5_000,
      timeoutFailure: "history",
      signal: outer.signal,
      createClient: async () => f.client,
    }),
  );
  const rejected = assert.rejects(
    read,
    (error: unknown) => error instanceof HistoryTimeoutFailure && error.reason === "total_deadline",
  );
  await entered.promise;
  t.mock.timers.tick(5_000);
  await rejected;
  await f.ended.promise;
  outer.dispose();
  assert.equal(f.state.destroys, 1);
});

test("the DO records signed-envelope validation and preserves 401 without inventing membership", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...values: unknown[]) => {
    logs.push(values);
  });
  const response = await handleUsageSeries(
    new Request(`https://example.test${poolUsageSeriesPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope: privateSentinel }),
    }),
    { signingKey: "ab".repeat(32), connectionString: undefined },
  );
  assert.equal(response.status, 401);
  assert.ok(logs.some((log) => JSON.stringify(log).includes("signed_envelope_validation")));
  assert.doesNotMatch(JSON.stringify(logs), /private-|membership/);
});

test("the signed series request deadline also bounds a stalled account-label callback", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...values: unknown[]) => {
    logs.push(values);
  });
  const key = "ab".repeat(32);
  const envelope = await signEnvelope(key, "sbs1", {
    action: "poolUsageSeries",
    pool: privateSentinel,
    user: privateSentinel,
    organization: privateSentinel,
    expiresAt: 20_000,
    input: { pool: privateSentinel, by: ["account"] },
    authority: { canManage: true, mappingProven: false, accounts: [] },
  });
  const entered = Promise.withResolvers<void>();
  const response = handleUsageSeries(
    new Request(`https://example.test${poolUsageSeriesPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    {
      signingKey: key,
      connectionString: undefined,
      accountLabels: async () => {
        entered.resolve();
        return new Promise(() => {});
      },
    },
  );
  await entered.promise;
  t.mock.timers.tick(5_000);
  const result = await response;
  assert.equal(result.status, 504);
  assert.deepEqual(await result.json(), {
    error: "history_timeout",
    message: "History is taking too long. Try again.",
  });
  assert.ok(logs.some((log) => JSON.stringify(log).includes("account_labels")));
  assert.doesNotMatch(JSON.stringify(logs), /private-|membership/);
});
