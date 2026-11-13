import type { PoolView } from "../../apps/pool/contract.ts";
import type { NativeMembershipSnapshot } from "./membership-contract.ts";
import { homeReferences } from "./home-references.ts";

/** Identity annotation never changes membership or routing, even when the source is ambiguous. */
export function nativeAccountView(
  view: PoolView,
  membership: NativeMembershipSnapshot | undefined,
): PoolView {
  if (membership?.native === false) return view;
  const identities = new Map<string, Set<string>>();
  for (const account of membership?.accounts ?? []) {
    if (account.homeReference === null) continue;
    for (const reference of homeReferences(account.homeReference)) {
      const found = identities.get(reference) ?? new Set<string>();
      found.add(account.account);
      identities.set(reference, found);
    }
  }
  return {
    ...view,
    accounts: view.accounts.map((account) => {
      const found = identities.get(account.id);
      return {
        ...account,
        nativeAccountId: found?.size === 1 ? [...found][0]! : null,
      };
    }),
  };
}
