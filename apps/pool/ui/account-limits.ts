import type { Account, PoolView, UsageWindow } from "../contract.ts";
import type { BankedResetGroup } from "../reset-observation-contract.ts";
import {
  resetCountText,
  type ReadingBalance,
  type ReadingObservation,
  type ReadingWindow,
} from "./observation-text.ts";

// Labels and scopes come normalized from the pool read. Nothing here reads provider fields or
// guesses a reset's kind: an older reading without groups stays one unclassified group. What a
// reset gives back, and every Details row, is the host's shared text and table.

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

const rank = (group: BankedResetGroup) =>
  group.scope.kind === "account" ? 0 : group.scope.kind === "model" ? 1 : 2;

export interface ResetSummary {
  /** Kinds kept apart: one weekly reset and three model resets are never "4 resets". */
  readonly parts: readonly { readonly key: string; readonly text: string }[];
  readonly accounts: readonly Account[];
  /** Accounts whose counts come from a reading that is no longer current. */
  readonly lastKnown: number;
}

export function resetSummary(view: PoolView, now: number): ResetSummary {
  const totals = new Map<string, { group: BankedResetGroup; count: number }>();
  const accounts: Account[] = [];
  for (const account of view.accounts) {
    const groups = resetGroups(account, now);
    if (groups.length === 0) continue;
    accounts.push(account);
    for (const group of groups) {
      const key = JSON.stringify([group.scope.kind, group.scope.id ?? null, group.reset.kind]);
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
    lastKnown: accounts.filter((account) => account.freshness !== "fresh").length,
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
 * The pool's account as the native report's readings, for the shared Details table. Every value
 * is the pool read's own: read times stay the source's, a window with no read time is left out
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
