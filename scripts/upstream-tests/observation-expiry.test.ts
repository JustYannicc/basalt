import assert from "node:assert/strict";
import { test } from "node:test";
import { expireReports } from "../../.upstream/apps/hosted/web/src/contracts/observation-expiry.ts";

const NOW = 1_000_000;
type Report = { readonly freshness: string; readonly result: { readonly deadline: number } | null };
const view = (reports: readonly Report[]) => ({ account: "acc_a", reports });
const deadlineOf = (result: { readonly deadline: number }) => result.deadline;
const report = (freshness: string, deadline: number | null): Report => ({
  freshness,
  result: deadline === null ? null : { deadline },
});

test("a fresh report turns stale at its deadline and only the earliest future one is scheduled", () => {
  const expired = expireReports(
    view([report("fresh", NOW - 1), report("fresh", NOW + 5_000), report("fresh", NOW + 9_000)]),
    NOW,
    deadlineOf,
  );
  assert.deepEqual(
    expired.view.reports.map((entry) => entry.freshness),
    ["stale", "fresh", "fresh"],
  );
  assert.equal(expired.next, NOW + 5_000);
  // The original deadline data is untouched: nothing is rewritten but the verdict.
  assert.deepEqual(expired.view.reports[0]?.result, { deadline: NOW - 1 });
});

test("an invalid deadline downgrades to stale and is never scheduled, so no zero-delay loop", () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const expired = expireReports(view([report("fresh", invalid)]), NOW, deadlineOf);
    assert.equal(expired.view.reports[0]?.freshness, "stale", `deadline ${invalid}`);
    assert.equal(expired.next, undefined, `deadline ${invalid} schedules nothing`);
  }
});

test("stale, outdated, unavailable and result-less reports are never promoted or scheduled", () => {
  const reports = [
    report("stale", NOW + 60_000),
    report("outdated", NOW + 60_000),
    report("unavailable", NOW + 60_000),
    report("fresh", null),
  ];
  const expired = expireReports(view(reports), NOW, deadlineOf);
  assert.deepEqual(
    expired.view.reports.map((entry) => entry.freshness),
    ["stale", "outdated", "unavailable", "fresh"],
  );
  assert.equal(expired.next, undefined);
});

test("recomputing at a passed deadline settles instead of scheduling the same instant again", () => {
  const first = expireReports(view([report("fresh", NOW + 5_000)]), NOW, deadlineOf);
  assert.equal(first.next, NOW + 5_000);
  const atDeadline = expireReports(view([report("fresh", NOW + 5_000)]), NOW + 5_000, deadlineOf);
  assert.equal(atDeadline.view.reports[0]?.freshness, "stale");
  assert.equal(atDeadline.next, undefined);
});
