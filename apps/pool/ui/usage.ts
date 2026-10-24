import type { Account, UsageWindow } from "../contract.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** "2d 20h", "3h 12m", "12m", "under a minute". */
export function duration(milliseconds: number): string {
  if (milliseconds < minute) return "under a minute";
  const days = Math.floor(milliseconds / day);
  const hours = Math.floor((milliseconds % day) / hour);
  const minutes = Math.floor((milliseconds % hour) / minute);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** "resets in 2d 20h", or null when the backend gave no reset time. */
export function resetsIn(window: Pick<UsageWindow, "resetAt">, now: number): string | null {
  if (!window.resetAt) return null;
  const at = Date.parse(window.resetAt);
  if (Number.isNaN(at)) return null;
  return at <= now ? "resetting now" : `resets in ${duration(at - now)}`;
}

/**
 * How much of the window's time is left, 0 to 1. Spending evenly would put the
 * fill exactly here, so the bar marks it.
 */
export function timeLeft(window: UsageWindow, now: number): number | null {
  if (!window.resetAt || !window.windowSeconds) return null;
  const at = Date.parse(window.resetAt);
  if (Number.isNaN(at)) return null;
  return clamp((at - now) / (window.windowSeconds * 1000));
}

export function percent(ratio: number): string {
  return `${Math.round(clamp(ratio) * 100)}%`;
}

export function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Shortest window first, so a 5-hour limit reads before a weekly one. */
export function orderedWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return [...windows].sort(
    (a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER),
  );
}

/** The account's longest window, which sets how much of it is really left. */
export function longestWindow(account: Account): UsageWindow | undefined {
  return orderedWindows(account.windows.filter((window) => window.remainingRatio !== null)).at(-1);
}

export interface ProviderCapacity {
  readonly provider: string;
  readonly accounts: number;
  readonly serving: number;
  /** Serving accounts with a usage reading; `left` is out of these. */
  readonly measured: number;
  /** Sum of each measured account's longest-window share left, out of `measured`. */
  readonly left: number;
  /** Per account, in list order: share left, or null when it isn't serving or has no data. */
  readonly segments: readonly (number | null)[];
  readonly nextReset: string | null;
  /** The backend's label for the window `left` counts, such as "Weekly". */
  readonly windowLabel: string | null;
}

/** Capacity per provider, the way the prototype's Accounts view adds it up. */
export function capacity(accounts: readonly Account[]): ProviderCapacity[] {
  const groups = new Map<string, Account[]>();
  for (const account of accounts) {
    groups.set(account.provider, [...(groups.get(account.provider) ?? []), account]);
  }
  return [...groups].map(([provider, members]) => {
    let left = 0;
    let serving = 0;
    let measured = 0;
    let nextReset: string | null = null;
    let windowLabel: string | null = null;
    const segments = members.map((account) => {
      const window = longestWindow(account);
      if (account.state !== "active") return null;
      serving += 1;
      if (!window) return null;
      measured += 1;
      left += window.remainingRatio ?? 0;
      windowLabel ??= window.label;
      if (window.resetAt && (!nextReset || Date.parse(window.resetAt) < Date.parse(nextReset))) {
        nextReset = window.resetAt;
      }
      return clamp(window.remainingRatio ?? 0);
    });
    return { provider, accounts: members.length, serving, measured, left, segments, nextReset, windowLabel };
  });
}

/** The newest usage reading across the pool. */
export function lastReading(accounts: readonly Account[]): number | null {
  const times = accounts.flatMap((account) => (account.observedAt ? [Date.parse(account.observedAt)] : []));
  const valid = times.filter((time) => !Number.isNaN(time));
  return valid.length ? Math.max(...valid) : null;
}

const exact = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function exactTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : exact.format(at);
}
