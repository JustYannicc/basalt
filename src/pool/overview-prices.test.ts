import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { OverviewPrices } from "./overview-prices.ts";

const now = Date.parse("2026-11-04T08:00:00Z");
const target = { provider: "openai", model: "fixture" };
const official = { input: 2, output: 8, cache_read: 0.2, cache_write: 2.5, request: 0 };
const row = { ...target, service_tier: "*", min_input_tokens: 0, status: "matched", official,
  final: { ...official, input: 200 }, existing_rule: { input_price_per_million: 999 } };

test("overview prices use the pinned official catalog and never Home's final billing multiplier", async () => {
  const calls: string[] = [];
  const client = new HomeClient(async (path) => {
    calls.push(new URL(path, "https://home.example.test").pathname);
    return Response.json({ source: "models.dev", atomic: true, source_version: "catalog-v1", source_fetched_at: new Date(now).toISOString(), rows: [row] });
  });
  const prices = new OverviewPrices(client);
  const result = await prices.read([target], now);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.input, "2");
  assert.equal(result[0]!.version, "catalog-v1");
  await prices.read([target], now + 60_000);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.endsWith("/billing/model-prices/import/preview"));
});

test("one invalid context band excludes that model rather than pricing only its cheap base", async () => {
  const client = new HomeClient(async () => Response.json({ source: "models.dev", atomic: true, source_version: "catalog-v1",
    source_fetched_at: new Date(now).toISOString(), rows: [row, { ...target, min_input_tokens: 200_000, status: "unsupported" }] }));
  assert.deepEqual(await new OverviewPrices(client).read([target], now), []);
});

test("stale and failed current price reads remain unavailable", async () => {
  const stale = new HomeClient(async () => Response.json({ source: "models.dev", atomic: true, source_version: "old",
    source_fetched_at: new Date(now - 2 * 86_400_000).toISOString(), rows: [row] }));
  assert.deepEqual(await new OverviewPrices(stale).read([target], now), []);
  const failed = new HomeClient(async () => { throw new Error("offline"); });
  assert.deepEqual(await new OverviewPrices(failed).read([target], now), []);
});
