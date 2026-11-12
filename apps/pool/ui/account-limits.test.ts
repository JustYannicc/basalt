import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, PoolView, UsageWindow } from "../contract.ts";
import type { BankedResetGroup } from "../reset-observation-contract.ts";
import {
  accountWindows,
  poolObservation,
  resetGroups,
  resetSummary,
  resetSummaryText,
} from "./account-limits.ts";
import { orderedWindows, resetEffect } from "./observation-text.ts";

const now = Date.parse("2026-11-12T10:00:00Z");
const window = (
  id: string,
  label: string,
  seconds: number,
  extra: Partial<UsageWindow> = {},
): UsageWindow => ({
  id,
  label,
  remainingRatio: 0.5,
  resetAt: null,
  windowSeconds: seconds,
  observedAt: "2026-11-12T09:55:00Z",
  ...extra,
});
const fiveHour = window("five_hour", "5 hours", 18_000);
const weekly = window("seven_day", "Weekly", 604_800);
const model = window("model_weekly", "Fable weekly", 604_800, {
  scope: { kind: "model", id: "fable" },
});
const fable: BankedResetGroup = {
  label: "Fable resets",
  available: 3,
  expiresAt: "2027-03-09T07:59:00.000Z",
  scope: { kind: "model", id: "fable" },
  reset: { kind: "model", clears: ["five_hour"], givesBackWeekly: true },
};
const week: BankedResetGroup = {
  label: "Weekly resets",
  available: 1,
  expiresAt: "2026-12-10T22:00:00.000Z",
  scope: { kind: "account" },
  reset: { kind: "weekly" },
};
const account = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  provider: "claude",
  label: id,
  plan: "max",
  state: "active",
  message: null,
  windows: [weekly, model, fiveHour],
  observedAt: "2026-11-12T09:55:00Z",
  freshness: "fresh",
  readingFailed: false,
  nextReadAt: null,
  earliestResetAt: null,
  bankedResets: { available: 4, nextExpiresAt: week.expiresAt, groups: [fable, week] },
  ...overrides,
});
const view = (accounts: Account[]): PoolView => ({ isOwner: true, providers: [], accounts });

test("whole-week and model resets stay separate, account resets first", () => {
  const summary = resetSummary(view([account("a")]), now);
  assert.equal(resetSummaryText(summary), "1 weekly reset · 3 Fable resets available");
  assert.deepEqual(
    summary.accounts.map((entry) => entry.id),
    ["a"],
  );
});

test("stale counts read as last known, never as current availability", () => {
  const stale = account("b", { freshness: "stale" });
  assert.equal(
    resetSummaryText(resetSummary(view([stale]), now)),
    "Last known: 1 weekly reset · 3 Fable resets",
  );
  assert.equal(
    resetSummaryText(resetSummary(view([account("a"), stale]), now)),
    "2 weekly resets · 6 Fable resets · last known for 1 account",
  );
});

test("expired groups are not available, and an old aggregate stays unclassified", () => {
  const later = Date.parse("2026-12-11T00:00:00Z");
  assert.deepEqual(
    resetGroups(account("a"), later).map((group) => group.label),
    ["Fable resets"],
  );
  assert.equal(
    resetSummary(view([account("a")]), Date.parse("2027-04-01T00:00:00Z")).parts.length,
    0,
  );
  const old = account("old", { bankedResets: { available: 2, nextExpiresAt: null } });
  assert.equal(
    resetSummaryText(resetSummary(view([old]), now)),
    "2 resets with unknown scope available",
  );
});

test("the pool's Details read the host's text: a model reset gives back only that model's week", () => {
  const observation = poolObservation(account("a"));
  const effects = Object.fromEntries(
    observation.balances.map((balance) => [
      balance.label,
      resetEffect(balance, observation.windows),
    ]),
  );
  assert.deepEqual(effects, {
    "Fable resets":
      "Gives back only the weekly use spent on Fable, not the whole week. Also refills the 5-hour limit.",
    "Weekly resets": "Refills the account's whole weekly limit.",
  });
  assert.deepEqual(
    observation.balances.map((balance) => [balance.available, balance.expiresAt]),
    [
      [3, "2027-03-09T07:59:00.000Z"],
      [1, "2026-12-10T22:00:00.000Z"],
    ],
  );
});

test("full and session resets claim only the windows the source lists", () => {
  const windows = poolObservation(account("a")).windows;
  const balance = (kind: "full" | "session", clears?: readonly string[]) => ({
    id: kind,
    label: "Resets",
    unit: "resets",
    available: 1,
    observedAt: "2026-11-12T09:55:00Z",
    scope: { kind: "account" as const },
    reset: { kind, ...(clears === undefined ? {} : { clears }) },
  });
  assert.equal(
    resetEffect(balance("full"), windows),
    "A full reset. The source didn't list which limits it refills.",
  );
  assert.equal(
    resetEffect(balance("full", ["five_hour", "seven_day"]), windows),
    "Refills the account's 5-hour limit and weekly limit.",
  );
  assert.equal(resetEffect(balance("session"), windows), "Refills the account's session limit.");
  const unknown = {
    ...balance("full"),
    scope: { kind: "unknown" as const },
    reset: { kind: "unknown" as const },
  };
  assert.equal(resetEffect(unknown, windows), "The source didn't say which limit this refills.");
});

test("a model's window sits right after its account window and never feeds capacity", () => {
  assert.deepEqual(
    orderedWindows(poolObservation(account("a")).windows).map((row) => [
      row.entry.label,
      row.within?.label ?? null,
    ]),
    [
      ["Weekly", null],
      ["Fable weekly", "Weekly"],
      ["5 hours", null],
    ],
  );
  assert.deepEqual(
    accountWindows(account("a")).windows.map((entry) => entry.label),
    ["Weekly", "5 hours"],
  );
});

test("the adapter keeps source read times and leaves unknown shares unknown", () => {
  const unread = account("u", {
    observedAt: null,
    windows: [window("w", "Weekly", 604_800, { observedAt: null, remainingRatio: null })],
  });
  const observation = poolObservation(unread);
  assert.deepEqual(observation.windows, []);
  assert.deepEqual(observation.balances, []);
  const unknownShare = poolObservation(
    account("k", { windows: [window("w", "Weekly", 604_800, { remainingRatio: null })] }),
  );
  assert.equal(unknownShare.windows[0]?.measure.remainingRatio, undefined);
  assert.equal(unknownShare.windows[0]?.observedAt, "2026-11-12T09:55:00Z");
});
