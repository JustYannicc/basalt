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
import { balanceView } from "../../../.upstream/packages/ui/src/implementation/dashboard/account-observation-text.ts";

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
// Window ids as the pool normalizes them; resets' `clears` name these same ids.
const fiveHour = window("claude-five-hour", "5 hours", 18_000);
const weekly = window("claude-seven-day", "Weekly", 604_800);
const model = window("claude-seven-day-fable", "Fable weekly", 604_800, {
  scope: { kind: "model", id: "fable" },
});
const fable: BankedResetGroup = {
  label: "Fable resets",
  available: 3,
  expiresAt: "2027-03-09T07:59:00.000Z",
  scope: { kind: "model", id: "fable" },
  reset: {
    kind: "model",
    clears: ["claude-five-hour", "claude-seven-day-fable"],
    givesBackWeekly: true,
  },
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
      "Refills the Fable weekly limit and gives back only the weekly use spent on Fable, not the whole week. Also refills the 5-hour limit.",
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

test("a model reset refills the model limit its source lists, never the account's week", () => {
  const windows = poolObservation(account("a")).windows;
  const modelReset = (
    label: string,
    id: string,
    clears: readonly string[],
    givesBackWeekly?: boolean,
  ) => ({
    id: `${id}-resets`,
    label,
    unit: "resets",
    available: 1,
    observedAt: "2026-11-12T09:55:00Z",
    scope: { kind: "model" as const, id },
    reset: {
      kind: "model" as const,
      clears,
      ...(givesBackWeekly === undefined ? {} : { givesBackWeekly }),
    },
  });
  // Listing the account's weekly window never turns a model reset into a whole-week refill.
  const fableEffect = resetEffect(
    modelReset("Fable resets", "fable", ["claude-seven-day", "claude-seven-day-fable"], true),
    windows,
  );
  assert.equal(
    fableEffect,
    "Refills the Fable weekly limit and gives back only the weekly use spent on Fable, not the whole week.",
  );
  assert.doesNotMatch(fableEffect ?? "", /whole weekly|Also refills the weekly/);
  // Giving back weekly use is itself the source saying the model's allowance refills, even with
  // no listed clear or no reported model window; no period is invented for it.
  const allowance =
    "Refills the Fable allowance and gives back only the weekly use spent on Fable, not the whole week.";
  assert.equal(resetEffect(modelReset("Fable resets", "fable", [], true), windows), allowance);
  assert.equal(
    resetEffect(
      modelReset("Fable resets", "fable", ["claude-seven-day-fable"], true),
      windows.filter((entry) => entry.scope?.kind !== "model"),
    ),
    allowance,
  );
  // Any model: its normalized clear id names that model's own window.
  const newModel = window("claude-seven-day-new-model", "New model weekly", 604_800, {
    scope: { kind: "model", id: "new-model" },
  });
  const generic = poolObservation(account("g", { windows: [weekly, newModel, fiveHour] }));
  const genericEffect = resetEffect(
    modelReset("New Model resets", "new-model", ["claude-seven-day-new-model"]),
    generic.windows,
  );
  assert.equal(genericEffect, "Refills the New model weekly limit.");
  assert.doesNotMatch(genericEffect ?? "", /didn't list|account's/);
  // Without a matching window or gives-back evidence, an unknown model's reset stays unlisted.
  assert.equal(
    resetEffect(
      modelReset("New Model resets", "new-model", ["claude-seven-day-other"]),
      generic.windows,
    ),
    "Applies to New Model only. The source didn't list which limits it refills.",
  );
  assert.equal(
    resetEffect(
      modelReset("New Model resets", "new-model", [
        "claude-seven-day-new-model",
        "claude-five-hour",
      ]),
      generic.windows,
    ),
    "Refills the New model weekly limit. Also refills the 5-hour limit.",
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
    resetEffect(balance("full", ["claude-five-hour", "claude-seven-day"]), windows),
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
  // An old aggregate count has no expiry: the shared Details say so instead of promising it lasts.
  const format = { locale: "en-US", timeZone: "UTC" };
  const aggregate = poolObservation(
    account("old", { bankedResets: { available: 2, nextExpiresAt: null } }),
  ).balances[0];
  assert.ok(aggregate);
  assert.equal(aggregate.expiresAt, undefined);
  assert.equal(balanceView(aggregate, now, format).when, "Expiry not reported");
  const [, dated] = poolObservation(account("a")).balances;
  assert.ok(dated);
  assert.match(balanceView(dated, now, format).when, /^Expires .*Dec/);
  assert.match(balanceView(dated, Date.parse("2027-01-01T00:00:00Z"), format).when, /^Expired /);
});
