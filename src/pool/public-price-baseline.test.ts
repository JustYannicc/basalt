import assert from "node:assert/strict";
import { test } from "node:test";
import { baselinePrices } from "./public-price-baseline.ts";
import { publicPriceSnapshot } from "../../scripts/public-price-baseline.ts";

const target = (model: string, provider = "codex") => ({ provider, model });
test("the shipped dated floor prices all current execution identities with complete context bands", () => {
  for (const model of ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5-5", "gpt-6.1-sol"]) {
    const { prices } = baselinePrices(target(model));
    assert.ok(prices.length > 0, model);
    assert.equal(prices[0]!.basis, "baseline");
    assert.equal(prices[0]!.asOf, "2026-11-12T14:54:20.000Z");
    assert.equal(
      prices[0]!.version,
      "fb66e34f3882207a4c7bb9d58f2429334a13d994c55b914718e763c2f62974f7",
    );
  }
  const rates = baselinePrices(target("gpt-6.1-sol")).prices;
  assert.deepEqual(
    rates.map((p) => [p.minInput, p.input, p.output, p.cacheRead, p.cacheWrite]),
    [
      ["0", "2", "10", "0.1", "2.5"],
      ["272001", "4", "15", "0.2", "5"],
    ],
  );
  assert.equal(
    baselinePrices(target("anthropic/claude-opus-5.5-20261101", "claude")).prices[0]!.input,
    "4",
  );
  assert.equal(baselinePrices(target("unpublished-model-9988")).prices.length, 0);
});

test("snapshot generation rejects a whole model if any expensive context band is malformed or separately billed", () => {
  const build = (cost: unknown) =>
    publicPriceSnapshot(
      JSON.stringify({
        openai: { models: { "new-model": { cost } } },
        anthropic: { models: { valid: { cost: { input: 1, output: 2 } } } },
      }),
      "2026-11-12T00:00:00Z",
    );
  for (const cost of [
    { input: 1, output: 2, tiers: [{ tier: { type: "context", size: 200000 }, input: 3 }] },
    { input: 1, output: 2, reasoning: 2 },
    {
      input: 1,
      output: 2,
      tiers: [{ tier: { type: "context", size: 200000 }, input: -3, output: 4 }],
    },
  ])
    assert.equal(build(cost).models.openai!["new-model"], null);
  assert.deepEqual(build({ input: 2, output: 10 }).models.openai!["new-model"], [
    ["0", "2", "10", "0.2", "2.5", "0"],
  ]);
});
