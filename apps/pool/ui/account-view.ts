import type { SelectedAccountView } from "apps";
import type { Account } from "../contract.ts";

/** A pool member with the provider app's own view of it, when the pool could read one. */
type Member = Account & { readonly nativeView?: SelectedAccountView };
export type Reports = NonNullable<
  Extract<SelectedAccountView, { state: "available" }>["observations"]
>["reports"];

/**
 * What this page may say about one account's readings. The pool's copy stays for accounts whose
 * provider app could not be resolved; a provider app that refuses inspection withholds them, so
 * the pool's copy never shows what the source would not.
 */
export type Inspection =
  | { readonly kind: "pool" }
  | { readonly kind: "withheld" }
  | { readonly kind: "native"; readonly reports: Reports };

export function inspection(account: Member): Inspection {
  if (account.nativeAccountId === null) return { kind: "withheld" };
  const view = account.nativeView;
  if (view === undefined) return { kind: "pool" };
  if (view.state === "denied" || !view.canInspect) return { kind: "withheld" };
  return { kind: "native", reports: view.observations?.reports ?? [] };
}

/** Reading facts behind the pool-level notes, or null where they are withheld. */
export interface ReadingFacts {
  readonly current: boolean;
  readonly failed: boolean;
  /** When the evidence for a problem was produced: the last attempt, else the reading. */
  readonly since: string | null;
}

const newest = (times: readonly (string | null | undefined)[]) =>
  times
    .filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

export function readingFacts(account: Member): ReadingFacts | null {
  const seen = inspection(account);
  if (seen.kind === "withheld") return null;
  if (seen.kind === "pool")
    return {
      current: account.freshness === "fresh",
      failed: account.readingFailed,
      since: account.collection?.lastAttemptAt ?? account.observedAt,
    };
  // Each source keeps its own record; the account is current when one of them is.
  const reports = seen.reports;
  const attempts = reports.flatMap((report) => (report.lastAttempt ? [report.lastAttempt] : []));
  const latest = [...attempts].sort(
    (a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt),
  )[0];
  return {
    current: reports.some((report) => report.result !== null && report.freshness === "fresh"),
    failed: latest !== undefined && latest.outcome !== "success",
    since:
      latest?.attemptedAt ?? newest(reports.map((report) => report.result?.observedAt ?? null)),
  };
}

/**
 * Capacity's per-account inputs. Forecasts and routing are the pool's own and keep its readings;
 * an account whose source withholds inspection still counts as a member but lends no plan or
 * window to the page.
 */
export const capacityInputs = (accounts: readonly Member[]): readonly Account[] =>
  accounts.map((account) =>
    inspection(account).kind === "withheld"
      ? { ...account, plan: null, windows: [], freshness: "never" as const }
      : account,
  );
