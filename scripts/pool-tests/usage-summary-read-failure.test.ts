import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { signEnvelope } from "../../src/pool/token.ts";
import {
  handleUsageSeries,
  poolUsageSummaryPath,
} from "../../src/pool/model-history/series-http.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture } from "./usage-summary-fixture.ts";

const signingKey = "ab".repeat(32);
const from = "2026-01-01T00:00:00Z",
  to = "2026-01-02T00:00:00Z";
const summary = async (authority: unknown, key = signingKey) =>
  new Request(`https://pool.example.test${poolUsageSummaryPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      envelope: await signEnvelope(key, "sbs1", {
        action: "poolUsageSummary",
        pool,
        user: "fixture-manager",
        organization: "fixture-organization",
        expiresAt: Date.now() + 30_000,
        input: { pool, from, to, authority },
      }),
    }),
  });

test("a usage summary held past its statement timeout names the statement, logs one failure and reports it once", async (t) => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${f.schema}`);
    const reported: string[] = [];
    const access = {
      signingKey,
      connectionString: url.href,
      failed: (action: string) => reported.push(action),
    };
    const errors = t.mock.method(console, "error", () => {});
    const info = t.mock.method(console, "info", () => {});
    const failures = () =>
      errors.mock.calls
        .filter((call) => call.arguments[0] === "POOL_USAGE_READ_FAILED")
        .map((call) => JSON.parse(String(call.arguments[1])) as Record<string, unknown>);

    // Another session holds the history table, as a long write or a migration would in production.
    const holder = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ${f.schema}.basalt_model_requests IN ACCESS EXCLUSIVE MODE`);
      const started = performance.now();
      const failed = await handleUsageSeries(await summary(fixture.authority), access);
      const elapsed = performance.now() - started;
      assert.equal(failed.status, 503, await failed.clone().text());
      assert.ok(elapsed >= 4_900 && elapsed < 9_000, `answered after ${Math.round(elapsed)} ms`);
      const [line, ...others] = failures();
      assert.deepEqual(others, []);
      assert.equal(line?.action, "poolUsageSummary");
      assert.equal(line?.status, 503);
      assert.equal(line?.failure, "statement_timeout");
      assert.equal(line?.step, "targets", "the first statement that reads the held table");
      assert.ok(Number.isSafeInteger(line?.statement), JSON.stringify(line));
      assert.ok(Number(line?.statementMs) >= 4_900, JSON.stringify(line));
      const phases = info.mock.calls
        .filter((call) => call.arguments[0] === "history_summary_phase")
        .map((call) => call.arguments[1] as Record<string, unknown>);
      assert.ok(
        phases.some(
          (phase) =>
            phase.phase === "sql_statement" &&
            phase.status === "error" &&
            phase.statement === line?.statement &&
            phase.step === "targets",
        ),
        "the failed statement has its own phase line",
      );
      assert.deepEqual(reported, ["poolUsageSummary"]);
      assert.doesNotMatch(
        JSON.stringify([errors.mock.calls, info.mock.calls].flat().map((call) => call.arguments)),
        /fixture-manager|fixture-organization|series-fixture|SELECT|basalt_model_requests/,
        "no caller data or SQL reaches the logs",
      );
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }

    // Once the table is free the same read answers, and nothing more is reported.
    const answered = await handleUsageSeries(await summary(fixture.authority), access);
    assert.equal(answered.status, 200, await answered.clone().text());
    // A refused assertion is not a failed read.
    const refused = await handleUsageSeries(
      await summary(fixture.authority, "cd".repeat(32)),
      access,
    );
    assert.equal(refused.status, 401);
    assert.equal(failures().length, 1);
    assert.deepEqual(reported, ["poolUsageSummary"]);
  });
});
