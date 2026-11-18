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

test("expired facts keep their last known value until a source decides", () => {
  const current = capacityWeight("codex", "Pro (Max)", 604_800);
  const aged = clock + 30 * 86_400_000;
  const weight = capacityWeight("codex", "Pro (Max)", 604_800, { now: aged });
  assert.equal(weight.known, true);
  assert.equal(weight.multiplier, current.multiplier);
  assert.deepEqual(weight.unit, current.unit);
  assert.equal(weight.revision, current.revision);
  assert.ok(weight.allowance!.expiresAt! <= aged);
  assert.match(weight.allowance!.detail!, /source expired/);
});

test("a newer revocation or a live row still decides over an expired value", () => {
  const now = clock + 30 * 86_400_000;
  const entry = {
    vendor: "openai",
    plan: "promax",
    windowSeconds: 604_800,
    full: 50,
    unit: { id: "chatgpt-plus-equivalent", label: "Plus-eq" },
    kind: "vendor" as const,
    verification: "verified" as const,
    sources: ["https://example.test/allowances.json"],
    checkedAt: clock - 86_400_000,
    fetchedAt: clock,
    expiresAt: clock + 86_400_000,
    revision: "synthetic-50",
  };
  const revoked = { ...entry, full: null, verification: "unknown" as const, fetchedAt: clock + 1 };
  const unknown = capacityWeight("codex", "Pro (Max)", 604_800, {
    now,
    catalog: { entries: [entry, revoked] },
  });
  assert.equal(unknown.known, false);
  const unlimited = {
    ...entry,
    full: null,
    unlimited: true,
    checkedAt: now - 1,
    expiresAt: now + 1,
  };
  assert.equal(
    capacityWeight("codex", "Pro (Max)", 604_800, {
      now,
      catalog: { entries: [entry, unlimited] },
    }).known,
    false,
  );
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

test("an expired plan keeps the row that last decided, not the latest fetched", () => {
  const expiry = clock + 86_400_000;
  const row = {
    vendor: "anthropic",
    plan: "max_20x",
    windowSeconds: 18_000,
    unit: { id: "claude-pro-equivalent", label: "Pro-eq" },
    sources: ["https://example.test/allowances.json"],
  };
  const policy = {
    ...row,
    full: 20,
    kind: "policy" as const,
    verification: "policy" as const,
    checkedAt: clock - 86_400_000,
    fetchedAt: clock - 86_400_000,
    expiresAt: expiry,
    revision: "policy-20",
  };
  const calibration = {
    ...row,
    full: 900_000,
    unit: { id: "observed-tokens", label: "tokens" },
    kind: "account-calibration" as const,
    verification: "verified" as const,
    checkedAt: expiry - 4 * 3_600_000,
    fetchedAt: expiry + 3_600_000,
    expiresAt: expiry - 2 * 3_600_000,
    revision: "calibration-900000",
  };
  const weight = capacityWeight("claude", "Max 20x", 18_000, {
    now: expiry + 2 * 3_600_000,
    catalog: { entries: [policy, calibration] },
  });
  assert.equal(weight.revision, "policy-20");
  assert.equal(weight.multiplier, 20);

  const disagreeing = {
    ...row,
    windowSeconds: 604_800,
    checkedAt: clock - 86_400_000,
    fetchedAt: clock,
    expiresAt: expiry,
    verification: "verified" as const,
  };
  const contradicted = capacityWeight("claude", "Max 20x", 604_800, {
    now: expiry + 3_600_000,
    catalog: {
      entries: [
        { ...disagreeing, full: 20, kind: "dataset" as const, revision: "dataset-20" },
        { ...disagreeing, full: 15, kind: "vendor" as const, revision: "vendor-15" },
      ],
    },
  });
  assert.equal(contradicted.known, false);
});
