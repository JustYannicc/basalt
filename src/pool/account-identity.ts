import type { Account } from "../../apps/pool/contract.ts";

/** The identity a connected subscription reports, the way a connected Gmail shows its address. */
export function identityOf(
  account: Pick<Account, "label" | "provider">,
  sites: readonly { readonly id: string; readonly site?: string }[],
) {
  const label = account.label.trim().slice(0, 255);
  const site = sites.find((provider) => provider.id === account.provider)?.site;
  return {
    ...(label ? { displayName: label } : {}),
    ...(/^[^\s@]+@[^\s@]+$/.test(label) ? { email: label } : {}),
    // The same logo service the dashboard uses for provider icons.
    ...(site ? { avatarUrl: `https://integrations.sh/logo/${site}?sz=64` } : {}),
  };
}
