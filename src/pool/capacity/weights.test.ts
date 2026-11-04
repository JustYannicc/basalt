import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityWeight } from "./weights.ts";

test("Claude session multipliers never become weekly multipliers", () => {
  assert.equal(capacityWeight("claude", "Max 5x", 18_000).multiplier, 5);
  assert.equal(capacityWeight("anthropic", "Max 20x", 18_000).multiplier, 20);
  const weekly = capacityWeight("claude", "Max 20x", 604_800);
  assert.equal(weekly.multiplier, 1);
  assert.equal(weekly.known, false);
  assert.equal(weekly.source, "unknown-plan");
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
