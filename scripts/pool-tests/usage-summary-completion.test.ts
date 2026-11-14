import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { digest } from "../../src/pool/backend-users.ts";
import { historyImportCompletionVersion } from "../../src/pool/model-history/import-completion-schema.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { historyTerminalIntegrityVersion } from "../../src/pool/model-history/schema.ts";
import { readPoolReliability } from "../../src/pool/model-history/reliability.ts";
import {
  recordTerminalStart,
  recordTerminalFinish,
} from "../../src/pool/model-history/terminal.ts";
import { addUsageDays, usageDayStart } from "../../src/pool/usage-calendar.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import {
  summaryCompletionFixture,
  summaryCounters,
  summaryFixture,
  summaryPrices,
} from "./usage-summary-fixture.ts";

const from = "2026-01-01T00:00:00Z",
  to = "2026-01-03T00:00:00Z";
const prices = async () => ({ prices: summaryPrices, issues: [] });

test("summary completion uses the canonical migration gate, exact certificate and source scope", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const proof = await summaryCompletionFixture(f);
    await f.insert(
      { ...summaryCounters, source: proof.source, timestamp: proof.completion.frozenFrom },
      { ...summaryCounters, source: await digest("uncertified-import") },
      { ...summaryCounters, source: await digest("pool-gateway-v1") },
    );
    const read = async () => {
      const summary = await poolUsageSummary(
        f.db,
        { pool, from, to, authority: fixture.authority },
        prices,
        Date.parse(to),
      );
      const series = await poolUsageSeries(
        f.db,
        {
          pool,
          from: summary.readFrom,
          to,
          bucket: "day",
          by: ["provider"],
          timezone: "Europe/Zurich",
        },
        fixture.authority,
      );
      assert.deepEqual(summary.coverage, series.coverage);
      assert.equal(summary.asOf, series.asOf);
      assert.equal(summary.coverage.capturedThrough, null);
      const completed = summary.coverage.sources.find((source) => source.source === proof.source);
      const unknown = summary.coverage.sources.find(
        (source) => source.kind === "import" && source.source !== proof.source,
      );
      assert.equal(unknown?.backfillComplete, false);
      assert.equal(unknown?.completion, undefined);
      assert.equal(
        summary.coverage.sources.find((source) => source.kind === "gateway")?.backfillComplete,
        null,
      );
      assert.deepEqual(
        summary.coverage.sources.map((source) => source.source).sort(),
        [proof.source, await digest("uncertified-import"), await digest("pool-gateway-v1")].sort(),
      );
      return completed;
    };
    const ready = await read();
    assert.equal(ready?.backfillComplete, true);
    assert.deepEqual(ready?.completion, proof.completion);
    await f.db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyImportCompletionVersion,
    ]);
    const pending = await read();
    assert.equal(pending?.backfillComplete, false);
    assert.equal(pending?.completion, undefined);
    await f.db.query("INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", [
      historyImportCompletionVersion,
    ]);
    assert.deepEqual((await read())?.completion, proof.completion);
    const foreign = await poolUsageSummary(
      f.db,
      { pool: "unrelated-pool", from, to, authority: fixture.authority },
      prices,
      Date.parse(to),
    );
    assert.equal(
      foreign.coverage.sources.some((source) => source.kind === "import"),
      false,
    );
  });
});

test("summary reuses the canonical native cursor and captured source record alongside import completion", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const proof = await summaryCompletionFixture(f);
    await f.insert({
      ...summaryCounters,
      source: proof.source,
      timestamp: proof.completion.frozenFrom,
    });
    await fixture.native(7, "2026-01-02T01:00:00Z");
    await fixture.cursor(7);
    const summary = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      prices,
      Date.parse(to),
    );
    const series = await poolUsageSeries(
      f.db,
      { pool, from: summary.readFrom, to, bucket: "day", by: ["provider"] },
      fixture.authority,
    );
    assert.deepEqual(summary.coverage, series.coverage);
    assert.equal(summary.asOf, series.asOf);
    assert.equal(summary.coverage.capturedThrough, "2026-01-02T01:00:00.000000000Z");
    const native = summary.coverage.sources.find((source) => source.kind === "home");
    assert.equal(native?.backfillComplete, true);
    assert.deepEqual(native?.sweep, { id: "0", upper: "0" });
    assert.deepEqual(
      summary.coverage.sources.find((source) => source.source === proof.source)?.completion,
      proof.completion,
    );
  });
});

test("summary incidents retain canonical terminal readiness without duplicate metadata reads", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const requestId = randomUUID();
    const at = "2026-01-02T23:30:00Z";
    await recordTerminalStart(f.db, {
      requestId,
      pool,
      person: null,
      at,
      pathname: "/v1/messages",
    });
    await recordTerminalFinish(f.db, requestId, {
      outcome: "truncated",
      status: 502,
      bytes: 123,
      at,
    });
    for (const ready of [true, false]) {
      if (!ready)
        await f.db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
          historyTerminalIntegrityVersion,
        ]);
      const summary = await poolUsageSummary(
        f.db,
        { pool, from, to, authority: fixture.authority },
        prices,
        Date.parse(to),
      );
      const canonical = await readPoolReliability(
        f.db,
        pool,
        summary.incidents.from,
        summary.incidents.to,
      );
      assert.equal(summary.incidents.failed, canonical.real.failed);
      assert.equal(summary.incidents.requests, canonical.real.requests);
      assert.equal(summary.incidents.failed, ready ? 1 : 0);
      assert.deepEqual(summary.incidents.failures, ready ? [{ status: 502, count: 1 }] : []);
    }
  });
});

test("summary forecasts cannot turn elapsed time beyond a canonical frozen import range into zero usage", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const proof = await summaryCompletionFixture(f);
    for (let day = 0; day < 84; day++) {
      const at = new Date(usageDayStart(addUsageDays("2026-08-17", day)) + 3_600_000).toISOString();
      await f.insert(
        ...Array.from({ length: 40 }, () => ({
          ...summaryCounters,
          source: proof.source,
          timestamp: at,
        })),
      );
    }
    await f.db.query(
      "UPDATE basalt_model_import_completion SET frozen_from=$1,frozen_to=$2,verified_rows=$3 WHERE pool=$4 AND source=$5",
      [
        "2026-08-16T22:00:00.000000000Z",
        "2026-11-08T23:00:00.000000000Z",
        "3360",
        (await digest(pool)).slice(0, 16),
        proof.source,
      ],
    );
    for (const end of ["2026-11-08T22:00:00Z", "2026-11-09T11:00:00Z"]) {
      const result = await poolUsageSummary(
        f.db,
        { pool, from: "2026-11-01T23:00:00Z", to: end, authority: fixture.authority },
        prices,
        Date.parse(end),
      );
      const requests = result.forecasts.series.find((series) => series.provider === null)?.requests;
      assert.equal(requests?.status, "available");
      if (requests?.status !== "available") return;
      assert.equal(requests.thisWeek.actual === null, end === "2026-11-09T11:00:00Z");
      assert.equal(requests.thisWeek.median === null, end === "2026-11-09T11:00:00Z");
      if (end === "2026-11-09T11:00:00Z") {
        assert.equal(requests.confidence, "Low");
        assert.ok(
          result.forecasts.warnings.some((warning) =>
            warning.includes("outside native capture and certified imported ranges"),
          ),
        );
      }
    }
  });
});
