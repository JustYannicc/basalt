import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityWeight, capacityWeightRevision } from "./weights.ts";

test("Claude uses each window's published multiplier for Home's exact plan identifiers", () => {
  // Pinned Home internal/quota/providers.go maps default_claude_max_20x to this exact name.
  for (const [plan, session, weekly] of [
    ["Max 20x", 20, 10],
    ["Max 5x", 5, 5],
  ] as const) {
    for (const provider of ["claude", "anthropic"]) {
      assert.equal(capacityWeight(provider, plan, 18_000).multiplier, session);
      const weight = capacityWeight(provider, plan, 604_800);
      assert.equal(weight.multiplier, weekly);
      assert.equal(weight.known, true);
      assert.equal(weight.source, "published-weekly-multiplier");
      assert.equal(weight.revision, capacityWeightRevision);
    }
  }
  assert.equal(capacityWeightRevision, "2026-11-09");
  assert.equal(capacityWeight("claude", "Max 20x", 86_400).known, false);
});

test("reference units stay fixed across pool composition and unknown tiers stay flagged", () => {
  assert.equal(capacityWeight("codex", "Plus", 604_800).known, true);
  assert.equal(capacityWeight("claude", "Pro", 604_800).known, true);
  for (const tier of ["Pro", "Pro 5x", "Pro 20x", "Pro 500", null]) {
    const value = capacityWeight("codex", tier, 604_800);
    assert.equal(value.known, false);
    assert.equal(value.multiplier, 1);
    assert.equal(value.unit.id, "chatgpt-plus-equivalent");
  }
});
