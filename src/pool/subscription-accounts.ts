import type { Account } from "../../apps/pool/contract.ts";
import providers from "./providers.json" with { type: "json" };

/** The subscription catalog owns quota capacity; app API keys retain their routing membership. */
export function subscriptionAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) =>
    providers.some((provider) => provider.id === account.provider),
  );
}
