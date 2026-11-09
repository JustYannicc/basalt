import type { Account } from "../../apps/pool/contract.ts";
import providers from "./providers.json" with { type: "json" };

/** Native models retain routing membership without counting as subscription capacity. */
export function subscriptionAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) =>
    providers.some((provider) => provider.id === account.provider && !("protocol" in provider)),
  );
}
