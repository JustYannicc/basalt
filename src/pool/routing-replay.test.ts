import { test } from "node:test";
import assert from "node:assert/strict";
import { replayQuotaDeadline } from "./routing-replay.ts";
import { compareRoutingCapacity } from "./routing-replay-advice.ts";
import type { RoutingReplayInput } from "./routing-replay-contract.ts";

const now = Date.UTC(2026, 10, 13),
  day = 24 * 3_600_000;
function fixture(first: number, later: number): RoutingReplayInput {
  const through = now + 4 * day;
  return {
    now,
    through,
    strategy: "quota-deadline",
    scenario: "median",
    accounts: [1, 4].map((reset, index) => ({
      id: index === 0 ? "a" : "b",
      usable: true,
      windows: [
        {
          seconds: 604800,
          mode: "fixed",
          full: 100,
          remaining: 80,
          resetAt: now + reset * day,
          rollingReleases: null,
        },
      ],
    })),
    demand: {
      revision: "synthetic-profile",
      provider: "claude",
      modelFamily: null,
      calculatedAt: new Date(now).toISOString(),
      validUntil: new Date(now + 15 * 60_000).toISOString(),
      source: "history-forecast",
      confidence: "medium",
      history: {
        from: new Date(now - 30 * day).toISOString(),
        through: new Date(now).toISOString(),
        coverageRatio: 1,
        censored: false,
        heldOutPeriods: 2,
        relativeError: 0.1,
      },
      windows: [
        {
          seconds: 604800,
          mode: "fixed",
          unit: { id: "synthetic-weekly", label: "weekly units", revision: "fixture" },
          calibration: "history-calibrated",
          calibrationRevision: "fixture",
          intervals: [
            {
              from: new Date(now).toISOString(),
              to: new Date(now + day).toISOString(),
              demand: { median: first, upper80: first },
            },
            {
              from: new Date(now + day).toISOString(),
              to: new Date(through).toISOString(),
              demand: { median: later, upper80: later },
            },
          ],
          accounts: ["a", "b"].map((account) => ({
            account,
            full: 100,
            known: true,
            plan: "Synthetic weekly",
            weightRevision: "fixture",
          })),
          candidatePlans: [],
        },
      ],
    },
  };
}
const near = (actual: number, expected: number, tolerance = 0.1) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test("pure replay matches native selector staggered-reset conformance cases", () => {
  const input = fixture(100, 150);
  const quota = replayQuotaDeadline(input),
    balanced = replayQuotaDeadline({ ...input, strategy: "round-robin" });
  near(quota.served, 250);
  near(quota.unserved, 0);
  near(quota.firstDayByAccount.a!, 80);
  near(quota.firstDayByAccount.b!, 20);
  near(balanced.served, 230);
  near(balanced.unserved, 20);
  const scarce = replayQuotaDeadline(fixture(40, 180));
  near(scarce.served, 220);
  near(scarce.unserved, 0);
  near(scarce.firstDayByAccount.a!, 40);
});

test("account sizing replays the new plan's initial allowance and refill cadence", () => {
  const input = fixture(100, 240);
  const advice = compareRoutingCapacity(input, {
    label: "Synthetic weekly",
    windows: [{ seconds: 604800, mode: "fixed", full: 100 }],
  });
  assert.equal(advice.classification, "needs-more-accounts");
  near(advice.flexible.unserved, 80);
  near(advice.flexible.provenCapacityShortfall, 80);
  assert.equal(advice.additionalAccounts, 1);
});

test("routing waste and sticky concentration are separate from intrinsic shortage", () => {
  const input = fixture(100, 150);
  assert.equal(
    compareRoutingCapacity({ ...input, strategy: "round-robin" }).classification,
    "routing-waste",
  );
  const sticky = {
    ...input,
    accounts: input.accounts.map((account) => ({
      ...account,
      affinityShare: account.id === "b" ? 0.7 : 0,
    })),
  };
  const advice = compareRoutingCapacity(sticky);
  assert.equal(advice.classification, "sticky-constraint");
  assert.equal(advice.additionalAccounts, null);
  assert.ok(advice.configured.unserved > 35);
});

test("missing five-hour evidence and editable shares remain unknown", () => {
  const input = fixture(100, 150);
  assert.equal(
    replayQuotaDeadline({ ...input, strategy: "weighted-round-robin" }).status,
    "unavailable",
  );
  const incomplete = {
    ...input,
    accounts: input.accounts.map((account) => ({
      ...account,
      windows: [
        ...account.windows,
        {
          seconds: 18000 as const,
          mode: "fixed" as const,
          full: 20,
          remaining: 10,
          resetAt: now + 5 * 3_600_000,
          rollingReleases: null,
        },
      ],
    })),
  };
  assert.equal(replayQuotaDeadline(incomplete).status, "unavailable");
});

test("replay and sizing remain correct when quota units are very small", () => {
  const original = fixture(100, 240),
    scale = 1e-12;
  const input: RoutingReplayInput = {
    ...original,
    accounts: original.accounts.map((account) => ({
      ...account,
      windows: account.windows.map((window) => ({
        ...window,
        full: window.full * scale,
        remaining: window.remaining * scale,
      })),
    })),
    demand: {
      ...original.demand,
      windows: original.demand.windows.map((window) => ({
        ...window,
        intervals: window.intervals.map((interval) => ({
          ...interval,
          demand: {
            median: interval.demand.median * scale,
            upper80: interval.demand.upper80! * scale,
          },
        })),
        accounts: window.accounts.map((account) => ({ ...account, full: account.full * scale })),
      })),
    },
  };
  const advice = compareRoutingCapacity(input, {
    label: "Small units",
    windows: [{ seconds: 604800, mode: "fixed", full: 100 * scale }],
  });
  assert.equal(advice.classification, "needs-more-accounts");
  assert.ok(Math.abs(advice.flexible.unserved / scale - 80) < 0.1);
  assert.equal(advice.additionalAccounts, 1);
});

test("invalid reset times, rolling releases and mixed deadline units refuse a capacity claim", () => {
  const base = fixture(100, 150);
  const invalidReset = {
    ...base,
    accounts: base.accounts.map((account) => ({
      ...account,
      windows: account.windows.map((window) => ({ ...window, resetAt: NaN })),
    })),
  };
  assert.equal(replayQuotaDeadline(invalidReset).status, "unavailable");
  const mixed: RoutingReplayInput = {
    ...base,
    accounts: base.accounts.map((account, index) => ({
      ...account,
      windows: account.windows.map((window) => ({
        ...window,
        seconds: index === 0 ? 18000 : 604800,
      })),
    })),
  };
  assert.equal(replayQuotaDeadline(mixed).status, "unavailable");
  const rolling: RoutingReplayInput = {
    ...base,
    accounts: base.accounts.map((account) => ({
      ...account,
      windows: account.windows.map((window) => ({
        ...window,
        mode: "rolling",
        rollingReleases: [{ at: now + day, amount: -1 }],
      })),
    })),
  };
  assert.equal(replayQuotaDeadline(rolling).status, "unavailable");
});
