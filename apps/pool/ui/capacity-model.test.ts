import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapacityAggregate, CapacityHistoryPoint, PoolCapacityHistory } from "../capacity-contract.ts";
import { capacityLabs, dailyRows, gaps, hourMs, lineFacts, planChips, pressing, segments } from "./capacity-model.ts";

const start = Date.parse("2026-11-02T00:00:00Z");

function aggregate(remaining: number, full: number, unknown = 0): CapacityAggregate {
  return {
    remaining, full, at: 0, observedAt: { from: 0, to: 0 }, accountCount: 2, knownWeightCount: 2 - unknown, unknownWeightCount: unknown,
    weights: [{ source: unknown ? "unknown-plan" : "reference-plan", revision: "r1", accountCount: 2 }],
  };
}

function point(hour: number, remaining: number, overrides: Partial<CapacityHistoryPoint> = {}): CapacityHistoryPoint {
  const value = aggregate(remaining, 4);
  return {
    provider: "claude", windowSeconds: 604800, mode: null, unit: { id: "pro-eq", label: "Pro-eq" }, hour: start + hour * hourMs,
    minimum: value, last: value, plans: [{ plan: "Pro", minimum: value, last: value }], ...overrides,
  };
}

const history = (points: CapacityHistoryPoint[]): PoolCapacityHistory =>
  ({ from: start, to: start + 24 * hourMs, points, estimate: { status: "unavailable", reason: "Not enough history." } });

test("labs split windows and only list the windows a lab reports", () => {
  const labs = capacityLabs(history([
    point(0, 2),
    point(0, 1, { windowSeconds: 18000 }),
    point(0, 3, { provider: "kimi", unit: { id: "requests", label: "requests" } }),
  ]));
  assert.deepEqual(labs.map((lab) => [lab.provider, lab.lines.map((line) => line.label)]), [["claude", ["Weekly", "5-hour"]], ["kimi", ["Weekly"]]]);
});

test("missing hours stay gaps and split the line", () => {
  const points = [point(0, 2), point(1, 2), point(4, 1)];
  assert.equal(segments(points).length, 2);
  assert.deepEqual(gaps(points, start + 6 * hourMs).map((span) => [(span.from - start) / hourMs, (span.to - start) / hourMs]), [[2, 4], [5, 6]]);
});

test("out hours count runs where every account was at its limit", () => {
  const [line] = capacityLabs(history([point(0, 2), point(1, 0), point(2, 0.01), point(3, 1), point(4, 0)]))[0]!.lines;
  const facts = lineFacts(line!, start + 5 * hourMs);
  assert.equal(facts.outHours, 3);
  assert.equal(facts.episodes, 2);
  assert.equal(facts.longestHours, 2);
});

test("the panel opens on the window with less left now", () => {
  const [lab] = capacityLabs(history([point(0, 3), point(0, 0, { windowSeconds: 18000 })]));
  const choice = pressing(lab!);
  assert.equal(lab!.lines.find((line) => line.key === choice.key)!.label, "5-hour");
  assert.match(choice.text!, /^5-hour is more pressing: out now; weekly 75% left now$/);
});

test("a lone window opens without a pressing note", () => {
  const [lab] = capacityLabs(history([point(0, 3)]));
  assert.equal(pressing(lab!).text, null);
});

test("unknown plans are flagged on their chip", () => {
  const flagged = aggregate(1, 2, 2);
  const chips = planChips(point(0, 1, { plans: [{ plan: null, minimum: flagged, last: flagged }] }));
  assert.deepEqual(chips, [{ plan: "No plan reported", accounts: 2, flagged: true, note: "plan unknown · 1x" }]);
});

test("daily rows count hours without readings since the first one", () => {
  const rows = dailyRows([point(2, 3), point(3, 1)], start + 6 * hourMs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.missingHours, 2);
  assert.equal(rows[0]!.lowest!.remaining, 1);
});
