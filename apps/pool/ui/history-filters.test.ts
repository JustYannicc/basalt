import assert from "node:assert/strict";
import { test } from "node:test";
import type { SeriesGroup } from "../usage-series-contract.ts";
import { historyMembers, parseHistoryFilters } from "./history-filters.ts";
import { mergeGroup } from "./series-model.ts";

test("History reads only the filters it supports from its address", () => {
  assert.deepEqual(parseHistoryFilters("?lab=codex&status=failed&from=2026-11-01&to=2026-11-14"), {
    lab: "codex",
    failed: true,
    dates: { from: "2026-11-01", to: "2026-11-14" },
  });
  assert.deepEqual(parseHistoryFilters("?lab=Codex!&status=ok&from=yesterday&account=x"), {
    dates: {},
  });
});

const group = (person: string, requests: number): SeriesGroup => ({
  key: { currency: "USD", person },
  buckets: [
    {
      at: "2026-11-10T00:00:00.000Z",
      partial: false,
      requests,
      failed: 0,
      unassignedFailures: 0,
      successRate: null,
    },
  ],
});

test("a current member's access never reads as having made requests", () => {
  assert.deepEqual(
    historyMembers(
      [
        { person: "a", displayName: "Ada", active: true },
        { person: "b", displayName: "Bo", active: true },
      ],
      [group("a", 3), group("b", 0)],
    ),
    [
      { person: "a", displayName: "Ada", active: true },
      { person: "b", displayName: "Bo", active: false },
    ],
  );
  assert.deepEqual(historyMembers(undefined, [group("a", 1)]), []);
});

test("an imported account keeps its label when its usage continues on a later page", () => {
  const first: SeriesGroup = {
    ...group("a", 1),
    accountDisplay: { kind: "imported-only", label: "Old laptop export" },
  };
  const merged = mergeGroup(first, group("a", 2));
  assert.deepEqual(merged.accountDisplay, { kind: "imported-only", label: "Old laptop export" });
  assert.equal(merged.buckets.length, 2);
  assert.deepEqual(mergeGroup(group("a", 1), first).accountDisplay, first.accountDisplay);
});
