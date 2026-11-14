import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import {
  summaryCompletionFixture,
  summaryCounters,
  summaryFixture,
  summaryPrices,
} from "./usage-summary-fixture.ts";

test("initial, refresh and model summary reads stay within the populated real-Postgres budget", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const people = await Promise.all(
      Array.from({ length: 64 }, (_, i) => digest(`fixture-person-${i}`)),
    );
    let id = 0;
    for (let day = 0; day < 84; day++) {
      const at = new Date(Date.parse("2026-01-01T00:45:00Z") + day * 86_400_000).toISOString();
      await f.insert(
        ...(await Promise.all(
          people.map(async (person, i) => ({
            ...summaryCounters,
            source: fixture.source,
            account: fixture.visible,
            person,
            timestamp: timestamp(at),
            model: `fixture-model-${i % 2}`,
            sourceRecord: await digest(JSON.stringify(["usage", String(++id)])),
            attribution: "key-at-capture" as const,
          })),
        )),
      );
    }
    await f.db.query(
      `INSERT INTO usage (id,timestamp,api_key)
      SELECT n,'2026-01-01T00:45:00Z'::timestamptz+((n-1)/64)*interval '1 day',$1
      FROM generate_series(1,$2::int) n`,
      [fixture.fingerprint, id],
    );
    for (const source of ["fixture-import", "pool-gateway-v1"])
      await f.insert({
        ...summaryCounters,
        source: await digest(source),
        timestamp: timestamp("2026-01-02T01:45:00Z"),
      });
    await fixture.cursor(id);
    await fixture.analyze();
    const from = "2026-01-01T00:00:00Z",
      to = "2026-03-26T00:00:00Z";
    for (const action of [
      "initial",
      "refresh",
      "model",
      "certified-initial",
      "certified-refresh",
      "certified-model",
    ] as const) {
      const models = action.endsWith("model");
      const proof = action === "certified-initial" ? await summaryCompletionFixture(f) : undefined;
      let priceReads = 0;
      const statements: { text: string; values?: unknown[] }[] = [];
      const counted: HistoryDatabase = {
        query: (text, values) => {
          statements.push({ text, values });
          return f.db.query(text, values);
        },
      };
      const result = await poolUsageSummary(
        counted,
        {
          pool,
          from,
          to,
          by: models ? "model" : "provider",
          authority: fixture.authority,
        },
        async (targets) => {
          priceReads++;
          assert.equal(targets.length, 2);
          return { prices: summaryPrices, issues: [] };
        },
        Date.parse(to),
      );
      assert.equal(
        result.daily
          .flatMap((group) => group.buckets)
          .reduce((n, bucket) => n + bucket.requests, 0),
        id + 2,
      );
      assert.equal(
        result.daily
          .flatMap((group) => group.buckets)
          .reduce(
            (n, bucket) => n + BigInt((bucket.details?.apiEstimate.amount ?? "0").replace(".", "")),
            0n,
          ),
        8_604_800_000_000n,
      );
      assert.equal(
        result.daily
          .flatMap((group) => group.buckets)
          .reduce((n, bucket) => n + (bucket.details?.apiEstimate.pricedRequests ?? 0), 0),
        id + 2,
      );
      assert.equal(result.previousDaily.length, 0);
      assert.equal(result.models === null, !models);
      if (models) assert.equal(result.models?.status, "available");
      if (proof) {
        const source = result.coverage.sources.find((source) => source.source === proof.source);
        assert.equal(source?.backfillComplete, true);
        assert.ok(source && "completion" in source);
        assert.deepEqual(source.completion, proof.completion);
      }
      const selects = statements.filter(({ text }) => /^\s*(WITH|SELECT)\b/i.test(text)).length;
      const priced = statements.filter(({ text }) => /\bpriced\s+AS\s*\(/i.test(text));
      assert.ok(selects <= 10, `${action} used ${selects} history SELECTs`);
      assert.ok(statements.length <= 15, `${action} used ${statements.length} SQL statements`);
      assert.equal(selects, 10);
      assert.equal(statements.length, 15);
      assert.equal(priced.length, 1);
      assert.equal(priceReads, 1);
      console.log(
        JSON.stringify({
          proof: "usage-summary-budget",
          action,
          requests: id + 2,
          selects,
          totalSql: statements.length,
          pricedStatements: priced.length,
          statementHashes: statements.map(({ text }) =>
            createHash("sha256").update(text).digest("hex"),
          ),
        }),
      );
      if (action === "initial") {
        const checkpoint = statements.find(({ text }) => text.includes("retained_first_at"));
        assert.ok(checkpoint);
        const retainedPlan = await f.db.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${checkpoint.text}`,
          checkpoint.values,
        );
        const retainedRoot = (
          retainedPlan.rows[0]!["QUERY PLAN"] as { Plan: Record<string, unknown> }[]
        )[0]!.Plan;
        let inspected = 0;
        const countRetainedReads = (node: Record<string, unknown>) => {
          if (
            typeof node["Relation Name"] === "string" &&
            node["Relation Name"].startsWith("basalt_model_requests")
          )
            inspected +=
              (Number(node["Actual Rows"]) + Number(node["Rows Removed by Filter"] ?? 0)) *
              Number(node["Actual Loops"]);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            countRetainedReads(child);
        };
        countRetainedReads(retainedRoot);
        assert.ok(inspected < 2100, `retained-start lookup inspected ${inspected} rows`);
        console.log(JSON.stringify({ proof: "usage-summary-retained-start-plan", inspected }));
        const statement = priced[0]!;
        const plan = await f.db.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
          statement.values,
        );
        const root = (plan.rows[0]!["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]!.Plan;
        const scans: Record<string, unknown>[] = [];
        const walk = (node: Record<string, unknown>) => {
          if (
            typeof node["Relation Name"] === "string" &&
            node["Relation Name"].startsWith("basalt_model_requests")
          )
            scans.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
        };
        walk(root);
        const sourceRows = scans.reduce(
          (n, scan) => n + Number(scan["Actual Rows"]) * Number(scan["Actual Loops"]),
          0,
        );
        assert.equal(sourceRows, id + 2);
        assert.ok(scans.every((scan) => scan["Actual Loops"] === 1));
        console.log(
          JSON.stringify({
            proof: "usage-summary-priced-plan",
            ledgerScans: scans.length,
            sourceRows,
            scans: scans.map((scan) =>
              Object.fromEntries(
                [
                  "Node Type",
                  "Relation Name",
                  "Actual Rows",
                  "Actual Loops",
                  "Shared Hit Blocks",
                  "Shared Read Blocks",
                ].map((key) => [key, scan[key]]),
              ),
            ),
          }),
        );
      }
    }
  });
});
