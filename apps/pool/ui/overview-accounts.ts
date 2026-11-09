import type { PoolView } from "../contract.ts";

/** Older server replies contained only subscriptions; current replies preserve every member. */
export function overviewAccounts(view: PoolView | undefined) {
  if (!view) return [];
  if (view.subscriptionAccountIds === undefined) return view.accounts;
  const ids = new Set(view.subscriptionAccountIds);
  return view.accounts.filter((account) => ids.has(account.id));
}
