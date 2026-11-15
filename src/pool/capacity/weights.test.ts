import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityWeight as resolveWeight, capacityWeightRevision } from "./weights.ts";

const clock = Date.parse("2026-11-13T12:00:00Z");
const capacityWeight = (
  provider: string,
  plan: string | null,
  seconds: number,
  options: Parameters<typeof resolveWeight>[3] = {},
) => resolveWeight(provider, plan, seconds, { now: clock, ...options });

test("a refreshed catalog changes a plan's allowance without changing code", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const entry = {
    vendor: "openai",
    plan: "promax",
    windowSeconds: 604_800,
    full: 37,
    unit: { id: "chatgpt-plus-equivalent", label: "Plus-eq" },
    kind: "dataset" as const,
    verification: "reported" as const,
    sources: ["https://example.test/allowances.json"],
    checkedAt: now - 86_400_000,
    fetchedAt: now,
    expiresAt: now + 86_400_000,
    revision: "synthetic-37",
  };
  const first = capacityWeight("codex", "promax", 604_800, {
    now,
    catalog: { entries: [entry] },
  });
  assert.equal(first.multiplier, 37);
  assert.equal(first.known, true);
  assert.equal(first.allowance?.checkedAt, entry.checkedAt);
  const updated = capacityWeight("openai", "Pro (Max)", 604_800, {
    now,
    catalog: { entries: [{ ...entry, full: 43, revision: "synthetic-43" }] },
  });
  assert.equal(updated.multiplier, 43);
  assert.equal(updated.revision, "synthetic-43");
});

test("Claude applies the pool plan policy alongside published window multipliers", () => {
  // Pinned Home internal/quota/providers.go maps default_claude_max_20x to this exact name.
  for (const [plan, session, weekly] of [
    ["Max 20x", 20, 20],
    ["Max 5x", 5, 5],
  ] as const) {
    for (const provider of ["claude", "anthropic"]) {
      assert.equal(capacityWeight(provider, plan, 18_000).multiplier, session);
      const weight = capacityWeight(provider, plan, 604_800);
      assert.equal(weight.multiplier, weekly);
      assert.equal(weight.known, true);
      assert.equal(
        weight.source,
        plan === "Max 20x" ? "plan-multiplier" : "published-weekly-multiplier",
      );
      assert.equal(weight.revision, plan === "Max 20x" ? "2026-11-09-max20x-20" : "2026-11-09");
    }
  }
  assert.equal(capacityWeightRevision, "2026-10-30");
  assert.equal(capacityWeight("claude", "Max 20x", 86_400).known, false);
});

test("known reference units and unknown tiers never acquire a shared guessed unit", () => {
  assert.equal(capacityWeight("codex", "Plus", 604_800).known, true);
  assert.equal(capacityWeight("claude", "Pro", 604_800).known, true);
  for (const tier of ["Unknown new tier", null]) {
    const value = capacityWeight("codex", tier, 604_800);
    assert.equal(value.known, false);
    assert.equal(value.multiplier, 1);
    assert.notEqual(value.unit.id, "chatgpt-plus-equivalent");
  }
  assert.notEqual(
    capacityWeight("codex", "Unknown new tier", 604_800).unit.id,
    capacityWeight("codex", null, 604_800).unit.id,
  );
});

test("expired seed facts become unknown independently of background refresh", () => {
  const weight = capacityWeight("codex", "Pro (Max)", 604_800, { now: clock + 30 * 86_400_000 });
  assert.equal(weight.known, false);
  assert.equal(weight.multiplier, 1);
  assert.match(weight.unit.id, /promax/);
});

test("Max 20x counts as twenty weekly units under the pool's plan policy", () => {
  for (const provider of ["claude", "anthropic"]) {
    const weight = capacityWeight(provider, "  MAX 20X  ", 604_800);
    assert.equal(weight.multiplier, 20);
    assert.equal(weight.source, "plan-multiplier");
    assert.equal(weight.known, true);
    assert.notEqual(weight.revision, "2026-11-09");
    assert.equal(capacityWeight(provider, "Max 20x", 18_000).multiplier, 20);
    assert.equal(capacityWeight(provider, "Max 5x", 604_800).multiplier, 5);
    assert.equal(capacityWeight(provider, "Max 5x", 604_800).revision, "2026-11-09");
    assert.equal(capacityWeight(provider, "Ultra", 604_800).multiplier, 10);
    assert.equal(capacityWeight(provider, "Ultra", 604_800).revision, "2026-11-09");
  }
});
