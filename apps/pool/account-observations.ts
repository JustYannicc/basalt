import type { ConnectContext, QueryContext } from "apps";
import type { AccountObservationResponse, Account } from "./contract.ts";
import { control } from "./control.ts";
import { accountStatus, checkFailure } from "./account-status.ts";
import { subscriptionFailure } from "./account-health.ts";
import { providers } from "./providers.ts";
import type { requirements } from "./requirements.ts";
import { ProviderError } from "apps";

type Caller = QueryContext<typeof requirements> | ConnectContext<typeof requirements>;

/** Owner reads include allowance. Existing member health checks keep their narrower route. */
export async function checkSubscription(ctx: Caller, ref: string) {
  const path = `/accounts/${encodeURIComponent(ref)}`;
  const observed = await control<AccountObservationResponse>(ctx, `${path}/observations`);
  if (observed.ok) {
    const failure = subscriptionFailure(observed.value.account);
    if (failure) throw new ProviderError({ reason: failure });
    return {
      ...accountStatus(observed.value.account, providers),
      ...(observed.value.observation === null ? {} : { observation: observed.value.observation }),
    };
  }
  if (observed.error !== "not_owner") throw new ProviderError({ reason: checkFailure(observed.error) });
  const checked = await control<Account>(ctx, `${path}/collect`, { method: "POST" });
  if (!checked.ok) throw new ProviderError({ reason: checkFailure(checked.error) });
  const failure = subscriptionFailure(checked.value);
  if (failure) throw new ProviderError({ reason: failure });
  return accountStatus(checked.value, providers);
}
