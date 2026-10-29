import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, UsageWindow } from "../contract.ts";
import { capacity, duration, lastReading, orderedWindows, resetsIn, timeLeft } from "./usage.ts";

const now = Date.parse("2026-10-23T12:00:00Z");
const hours = (count: number) => count * 3_600_000;

function window(overrides: Partial<UsageWindow>): UsageWindow {
  return { id: "w", label: "Weekly", remainingRatio: 0.5, resetAt: null, windowSeconds: null, observedAt: null, ...overrides };
}

function account(overrides: Partial<Account>): Account {
  return {
    id: "a",
    provider: "p",
    label: "account",
    plan: null,
    state: "active",
    message: null,
    windows: [],
    observedAt: null,
    freshness: "never", readingFailed: false, nextReadAt: null, earliestResetAt: null, bankedResets: null,
    ...overrides,
  };
}

test("durations read as the largest two units", () => {
  assert.equal(duration(30_000), "under a minute");
  assert.equal(duration(12 * 60_000), "12m");
  assert.equal(duration(hours(3) + 12 * 60_000), "3h 12m");
  assert.equal(duration(hours(68)), "2d 20h");
  assert.equal(duration(hours(48)), "2d");
});

test("reset countdown and the share of the window's time left", () => {
  const weekly = window({ resetAt: new Date(now + hours(84)).toISOString(), windowSeconds: 7 * 24 * 3600 });
  assert.equal(resetsIn(weekly, now), "resets in 3d 12h");
  assert.equal(timeLeft(weekly, now), 0.5);
  assert.equal(resetsIn(window({ resetAt: new Date(now - 1000).toISOString() }), now), "resetting now");
  assert.equal(resetsIn(window({}), now), null);
  assert.equal(timeLeft(window({ resetAt: weekly.resetAt }), now), null);
});

test("windows sort shortest first, unknown lengths last", () => {
  const sorted = orderedWindows([
    window({ id: "weekly", windowSeconds: 604_800 }),
    window({ id: "unknown" }),
    window({ id: "five", windowSeconds: 18_000 }),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["five", "weekly", "unknown"]);
});

test("capacity adds each serving account's longest window, per provider", () => {
  const soon = new Date(now + hours(2)).toISOString();
  const later = new Date(now + hours(50)).toISOString();
  const groups = capacity([
    account({ id: "1", provider: "x", windows: [window({ windowSeconds: 18_000, remainingRatio: 0.1 }), window({ windowSeconds: 604_800, remainingRatio: 0.6, resetAt: later })] }),
    account({ id: "2", provider: "x", windows: [window({ windowSeconds: 604_800, remainingRatio: 1, resetAt: soon })] }),
    account({ id: "3", provider: "x", state: "disabled", windows: [window({ windowSeconds: 604_800, remainingRatio: 1 })] }),
    account({ id: "4", provider: "y" }),
  ]);
  assert.equal(groups.length, 2);
  const [x, y] = groups;
  assert.equal(x!.accounts, 3);
  assert.equal(x!.serving, 2);
  assert.equal(x!.measured, 2);
  assert.ok(Math.abs(x!.left - 1.6) < 1e-9);
  assert.deepEqual(x!.segments, [0.6, 1, null]);
  assert.equal(x!.nextReset, soon);
  assert.equal(x!.windowLabel, "Weekly");
  assert.deepEqual(y!.segments, [null]);
  assert.equal(y!.serving, 1);
  assert.equal(y!.measured, 0);
  assert.equal(y!.left, 0);
});

test("the newest usage reading wins", () => {
  assert.equal(lastReading([account({}), account({ observedAt: "2026-10-23T11:00:00Z" }), account({ observedAt: "2026-10-23T11:30:00Z" })]), Date.parse("2026-10-23T11:30:00Z"));
  assert.equal(lastReading([account({})]), null);
});
