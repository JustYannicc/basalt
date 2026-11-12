import { overviewAccounts } from "./overview-accounts.ts";
import { resetSummary, resetSummaryText } from "./account-limits.ts";
import type { PoolView } from "../contract.ts";
import { readingFacts } from "./account-view.ts";

export interface AccountProblem {
  readonly kind: "sign-in" | "checks" | "readings" | "unavailable";
  readonly count: number;
  readonly text: string;
  readonly since: string | null;
}

/** Keep overlapping account symptoms separate instead of adding them into a fake account total. */
export function accountProblems(view: PoolView): AccountProblem[] {
  // Withheld readings are neither stale nor failed here; the source's own Accounts row says.
  const facts = (account: PoolView["accounts"][number]) => readingFacts(account);
  const signIn = view.accounts.filter((account) => account.credentialFailure === "unauthorized");
  const checks = view.accounts.filter((account) => facts(account)?.failed === true);
  const readings = overviewAccounts(view).filter((account) => facts(account)?.current === false);
  const unavailable = view.accounts.filter(
    (account) => account.state !== "active" || account.credentialFailure === "unavailable",
  );
  const since = (accounts: PoolView["accounts"]) => {
    const times = accounts
      .map((account) => facts(account)?.since)
      .filter(
        (at): at is string => at !== null && at !== undefined && Number.isFinite(Date.parse(at)),
      );
    return times.sort()[0] ?? null;
  };
  return [
    {
      kind: "sign-in" as const,
      count: signIn.length,
      text: signIn.length === 1 ? "account needs sign-in" : "accounts need sign-in",
      since: since(signIn),
    },
    {
      kind: "checks" as const,
      count: checks.length,
      text:
        checks.length === 1
          ? "account failed its latest usage check"
          : "accounts failed their latest usage check",
      since: since(checks),
    },
    {
      kind: "readings" as const,
      count: readings.length,
      text:
        readings.length === 1
          ? "account has stale or missing readings"
          : "accounts have stale or missing readings",
      since: since(readings),
    },
    {
      kind: "unavailable" as const,
      count: unavailable.length,
      text:
        unavailable.length === 1
          ? "account is unavailable or paused"
          : "accounts are unavailable or paused",
      since: since(unavailable),
    },
  ].filter((problem) => problem.count > 0);
}

/**
 * Distinct accounts a person has to act on, each counted once. A stale or first reading alone
 * isn't one: it stays a pool-level note until a check actually fails.
 */
export const accountsNeedingSomeone = (view: PoolView) =>
  view.accounts.filter(
    (account) =>
      account.credentialFailure !== undefined ||
      readingFacts(account)?.failed === true ||
      account.state !== "active",
  ).length;

/** Banked resets by kind and scope; null when none is left. Never one combined total. */
export function bankedResetLine(view: PoolView, now: number) {
  const summary = resetSummary(view, now);
  return summary.parts.length === 0 ? null : { ...summary, text: resetSummaryText(summary) };
}

/** The total decides the noun: "1 of 1 person", "0 of 3 people". */
export const peopleOfText = (active: number, total: number) =>
  `${active} of ${total} ${total === 1 ? "person" : "people"}`;
