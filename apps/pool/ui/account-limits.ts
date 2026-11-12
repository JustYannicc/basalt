import { availableResetBalances } from "apps";
import type { Account, PoolView, UsageWindow } from "../contract.ts";
import type { BankedResetGroup } from "../reset-observation-contract.ts";
import { inspection, readingFacts, type Reports } from "./account-view.ts";
import {
  resetCountText,
  type ReadingBalance,
  type ReadingObservation,
  type ReadingWindow,
} from "./observation-text.ts";

// Labels and scopes come normalized from the pool read, or as the provider app reported them.
// Nothing here reads provider fields or guesses a reset's kind: an older reading without groups
// stays one unclassified group. What a reset gives back, and every Details row, is the host's
// shared text and table.

export const isModelWindow = (window: UsageWindow) => window.scope?.kind === "model";

/** The account's own windows, so a model's limit never reads as extra account capacity. */
export const accountWindows = (account: Account): Account =>
  account.windows.some(isModelWindow)
    ? { ...account, windows: account.windows.filter((window) => !isModelWindow(window)) }
    : account;

/** Every reported group with something in it, expired or not. */
function bankedGroups(account: Account): readonly BankedResetGroup[] {
  const banked = account.bankedResets;
  if (!banked) return [];
  if (banked.groups) return banked.groups.filter((group) => group.available > 0);
  return banked.available > 0
    ? [
        {
          label: "Resets with unknown scope",
          available: banked.available,
          expiresAt: null,
          scope: { kind: "unknown" },
          reset: { kind: "unknown" },
        },
      ]
    : [];
}

/** Unexpired groups with something left. */
export const resetGroups = (account: Account, now: number) =>
  bankedGroups(account).filter(
    (group) => group.expiresAt === null || Date.parse(group.expiresAt) > now,
  );

type CountedReset = Pick<ReadingBalance, "label" | "available" | "scope" | "reset">;

const rank = (group: CountedReset) =>
  group.scope?.kind === "account" ? 0 : group.scope?.kind === "model" ? 1 : 2;

const newest = <T extends { readonly observedAt: string | null }>(items: readonly T[]) => {
  const time = (item: T) => (item.observedAt === null ? Number.NaN : Date.parse(item.observedAt));
  return items.filter((item) => Number.isFinite(time(item))).sort((a, b) => time(b) - time(a))[0];
};

/**
 * Unexpired resets this page may count for one account: the provider app's newest reading, so two
 * sources reporting one balance never count it twice, else the pool's copy. Withheld adds none.
 */
function liveResets(account: Account, now: number): readonly CountedReset[] {
  const seen = inspection(account);
  if (seen.kind === "withheld") return [];
  if (seen.kind === "pool") return resetGroups(account, now);
  const result = newest(seen.reports.flatMap((report) => (report.result ? [report.result] : [])));
  return result ? availableResetBalances(result.observation, now) : [];
}

export interface ResetSummary {
  /** Kinds kept apart: one weekly reset and three model resets are never "4 resets". */
  readonly parts: readonly { readonly key: string; readonly text: string }[];
  readonly accounts: readonly Account[];
  /** Accounts whose counts come from a reading that is no longer current. */
  readonly lastKnown: number;
}

export function resetSummary(view: PoolView, now: number): ResetSummary {
  const totals = new Map<string, { group: CountedReset; count: number }>();
  const accounts: Account[] = [];
  for (const account of view.accounts) {
    const groups = liveResets(account, now);
    if (groups.length === 0) continue;
    accounts.push(account);
    for (const group of groups) {
      // A reported balance without scope or kind is the same unclassified group as an older read.
      const key = JSON.stringify([
        group.scope?.kind ?? "unknown",
        group.scope?.id ?? null,
        group.reset?.kind ?? "unknown",
      ]);
      const total = totals.get(key);
      totals.set(key, {
        group: total?.group ?? group,
        count: (total?.count ?? 0) + group.available,
      });
    }
  }
  const parts = [...totals]
    .sort(
      ([, a], [, b]) => rank(a.group) - rank(b.group) || a.group.label.localeCompare(b.group.label),
    )
    .map(([key, { group, count }]) => ({ key, text: resetCountText(group, count) }));
  return {
    parts,
    accounts,
    lastKnown: accounts.filter((account) => readingFacts(account)?.current !== true).length,
  };
}

/** A stale count is last known, never current availability. */
export function resetSummaryText(summary: ResetSummary) {
  const list = summary.parts.map((part) => part.text).join(" · ");
  if (summary.lastKnown === 0) return `${list} available`;
  if (summary.lastKnown === summary.accounts.length) return `Last known: ${list}`;
  return `${list} · last known for ${summary.lastKnown} ${summary.lastKnown === 1 ? "account" : "accounts"}`;
}

/**
 * The pool's account as the native report's readings, for the shared Details table, only where
 * no provider app could be resolved. Every value is the pool read's own: read times stay the source's, a window with no read time is left out
 * rather than dated now, and an unknown share stays unknown.
 */
export function poolObservation(account: Account): ReadingObservation {
  const read = account.observedAt;
  const windows = account.windows.flatMap((window): ReadingWindow[] => {
    const observedAt = window.observedAt ?? read;
    if (observedAt === null) return [];
    return [
      {
        id: window.id,
        label: window.label,
        observedAt,
        ...(window.scope === undefined ? {} : { scope: window.scope }),
        measure: {
          unit: "%",
          ...(window.remainingRatio === null ? {} : { remainingRatio: window.remainingRatio }),
        },
        ...(window.windowSeconds === null ? {} : { period: { seconds: window.windowSeconds } }),
        ...(window.resetAt === null ? {} : { resetsAt: window.resetAt }),
      },
    ];
  });
  const balances =
    read === null
      ? []
      : bankedGroups(account).map((group): ReadingBalance => ({
          id: JSON.stringify([
            group.scope.kind,
            group.scope.id ?? null,
            group.reset.kind,
            group.expiresAt,
          ]),
          label: group.label,
          unit: "resets",
          available: group.available,
          observedAt: read,
          ...(group.expiresAt === null ? {} : { expiresAt: group.expiresAt }),
          scope: group.scope,
          reset: group.reset,
        }));
  return {
    // The pool read does not carry the offering; the plan row names the plan itself.
    offering: "unknown",
    ...(account.plan === null || read === null
      ? {}
      : { plan: { label: account.plan, observedAt: read } }),
    windows,
    balances,
  };
}

/** One record behind an account's Details: a provider app's report, or the pool's own copy. */
export interface AccountReading {
  readonly key: string;
  /** Who reported it; null for the pool's copy. */
  readonly source: string | null;
  /** Null until the source has a reading. */
  readonly observation: ReadingObservation | null;
  readonly observedAt: string | null;
  /** "none" until the source has a current or retained reading. */
  readonly state: "current" | "last-known" | "none";
  /** The latest check when it failed. Its last reading, if any, stays shown. */
  readonly failure: { readonly at: string; readonly outcome: string } | null;
}

const nativeReading = (report: Reports[number], index: number): AccountReading => ({
  key: `${report.source.kind}:${report.source.id}:${index}`,
  source: report.source.label,
  observation: report.result?.observation ?? null,
  observedAt: report.result?.observedAt ?? null,
  state:
    report.result === null ? "none" : report.freshness === "fresh" ? "current" : "last-known",
  failure:
    report.lastAttempt && report.lastAttempt.outcome !== "success"
      ? { at: report.lastAttempt.attemptedAt, outcome: report.lastAttempt.outcome }
      : null,
});

/**
 * What Details may show for an account, or null where its provider app withholds inspection. A
 * resolved provider app's reports render as reported; the pool's copy is only for accounts whose
 * provider app could not be resolved.
 */
export function accountReadings(account: Account): readonly AccountReading[] | null {
  const seen = inspection(account);
  if (seen.kind === "withheld") return null;
  if (seen.kind === "native") return seen.reports.map(nativeReading);
  return [
    {
      key: "pool",
      source: null,
      observation: poolObservation(account),
      observedAt: account.observedAt,
      state:
        account.freshness === "fresh"
          ? "current"
          : account.freshness === "never"
            ? "none"
            : "last-known",
      failure: null,
    },
  ];
}

/** The newest reading with readings in it, as the one a summary quotes. */
export const latestReading = (readings: readonly AccountReading[] | null) =>
  newest((readings ?? []).filter((reading) => reading.observation !== null));
