import type { PoolView } from "../contract.ts";

export interface AccountProblem {
  readonly kind: "sign-in" | "checks" | "readings" | "unavailable";
  readonly count: number;
  readonly text: string;
  readonly since: string | null;
}

/** Keep overlapping account symptoms separate instead of adding them into a fake account total. */
export function accountProblems(view: PoolView): AccountProblem[] {
  const signIn = view.accounts.filter((account) => account.credentialFailure === "unauthorized");
  const checks = view.accounts.filter((account) => account.readingFailed);
  const readings = view.accounts.filter((account) => account.freshness !== "fresh");
  const unavailable = view.accounts.filter(
    (account) => account.state !== "active" || account.credentialFailure === "unavailable",
  );
  const since = (accounts: PoolView["accounts"]) => {
    const times = accounts
      .map((account) => account.collection?.lastAttemptAt ?? account.observedAt)
      .filter(
        (at): at is string => at !== null && at !== undefined && Number.isFinite(Date.parse(at)),
      );
    return times.sort()[0] ?? null;
  };
  return [
    {
      kind: "sign-in" as const,
      count: signIn.length,
      text: "accounts need sign-in",
      since: since(signIn),
    },
    {
      kind: "checks" as const,
      count: checks.length,
      text: "accounts failed their latest usage check",
      since: since(checks),
    },
    {
      kind: "readings" as const,
      count: readings.length,
      text: "accounts have stale or missing readings",
      since: since(readings),
    },
    {
      kind: "unavailable" as const,
      count: unavailable.length,
      text: "accounts are unavailable or paused",
      since: since(unavailable),
    },
  ].filter((problem) => problem.count > 0);
}

/** Distinct accounts behind any problem above, so overlapping symptoms count each account once. */
export const accountsWithProblems = (view: PoolView) =>
  view.accounts.filter(
    (account) =>
      account.credentialFailure !== undefined ||
      account.readingFailed ||
      account.freshness !== "fresh" ||
      account.state !== "active",
  ).length;

export const bankedResetCount = (view: PoolView) =>
  view.accounts.reduce((sum, account) => sum + (account.bankedResets?.available ?? 0), 0);
