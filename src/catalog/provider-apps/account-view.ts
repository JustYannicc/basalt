import type { AccountCheckContext, AuthMethods } from "apps";
import { SelectedAccountReadFailed } from "apps/contracts";

/** Read only the exact native selection; never search other accounts or refresh a provider. */
export const readAccountView = (
  accounts: readonly Pick<AccountCheckContext<AuthMethods>["account"], "id" | "read">[],
  account: string,
) => {
  const selected = accounts.find((candidate) => candidate.id === account);
  if (selected === undefined)
    throw new SelectedAccountReadFailed({ reason: "invalid_input", retryable: false });
  return selected.read();
};
