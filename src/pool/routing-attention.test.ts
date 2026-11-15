import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityAttention, type CapacityOutlookInput } from "./routing-attention.ts";

const now = Date.UTC(2026, 10, 13),
  day = 24 * 3_600_000;
function outlook(days: number): CapacityOutlookInput {
  return {
    provider: "claude",
    modelFamily: "opus",
    from: new Date(now).toISOString(),
    through: new Date(now + 7 * day).toISOString(),
    status: "needs-more-accounts",
    evidence: {
      source: "history-forecast",
      status: "calibrated",
      confidence: "medium",
      revision: "fixture",
      calculatedAt: new Date(now).toISOString(),
      validUntil: new Date(now + 15 * 60_000).toISOString(),
      historyFrom: new Date(now - 30 * day).toISOString(),
      historyThrough: new Date(now).toISOString(),
      coverageRatio: 0.95,
      heldOutPeriods: 2,
      backtestRelativeError: 0.1,
      unit: { id: "weekly", label: "weekly", calibrationRevision: "fixture" },
      reasons: [],
    },
    scenarios: [
      {
        demand: "median",
        configuredUnserved: 1,
        feasibleUnserved: 1,
        expiringUnused: 0,
        firstShortfallAt: new Date(now + days * day).toISOString(),
        bottleneck: "weekly",
      },
    ],
    recommendation: null,
  };
}

test("a near median shortage needs five-minute confirmation before one episode can nudge", () => {
  const first = capacityAttention(outlook(2), null, now);
  assert.equal(first.attention.notice, "needs-more-accounts");
  assert.equal(first.attention.inboxNudge, "none");
  const next = capacityAttention(outlook(2), first.state, now + 5 * 60_000);
  assert.equal(next.attention.inboxNudge, "eligible");
  assert.equal(next.attention.episode, first.attention.episode);
  const cleared = capacityAttention(
    { ...outlook(2), status: "enough" },
    next.state,
    now + 6 * 60_000,
  );
  assert.equal(cleared.attention.notice, "none");
  assert.equal(cleared.state, null);
});

test("low confidence, expired evidence, upper-only risk and distant shortages never nudge", () => {
  const base = outlook(2);
  for (const input of [
    { ...base, evidence: { ...base.evidence, confidence: "low" as const } },
    { ...base, evidence: { ...base.evidence, validUntil: new Date(now).toISOString() } },
    {
      ...base,
      scenarios: base.scenarios.map((scenario) => ({ ...scenario, demand: "upper-80" as const })),
    },
    outlook(8),
  ]) {
    const result = capacityAttention(input, null, now);
    assert.equal(result.attention.notice, "none");
    assert.equal(result.attention.inboxNudge, "none");
  }
  assert.equal(capacityAttention(outlook(4), null, now).attention.reason, "notice-only");
});
