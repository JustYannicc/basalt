import type { Account } from "../../apps/pool/contract.ts";
import { accountsView } from "./accounts-view.ts";
import type { HomeClient, PoolHome } from "./control.ts";
import { fail, object, unavailable } from "./json.ts";
import type { QuotaCollection } from "./quota-collection.ts";

export async function checkAccount(home: PoolHome, client: HomeClient, collection: QuotaCollection, id: string, callerSignal: AbortSignal): Promise<Account> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(12_000)]);
  const ids = new Set((await home.membership(signal)).members.map((member) => member.auth_id));
  if (!ids.has(id)) return fail(404, "not_found", "This subscription was removed from the pool.");
  const [files, reading] = await Promise.all([home.credentials(signal), collection.read(id, signal)]);
  const account = accountsView(files, reading ? [reading] : [], new Set([id]))[0];
  if (!account) return fail(404, "not_found", "This subscription was removed from the pool.");
  const file = files.find((file) => file.id === id)!;
  if (file.status === "error" || file.unavailable === true) {
    const runtime = await client.data(`/credentials/${encodeURIComponent(id)}/model-states`, { signal });
    const credential = object(runtime.credential) ? runtime.credential : undefined;
    if (credential?.credential_id !== id) return unavailable();
    if (credential.refresh_blocked === true || file.status === "error") {
      const error = object(credential.last_error) ? credential.last_error : undefined;
      const upstream = object(error?.upstream) ? error.upstream : undefined;
      return { ...account, credentialFailure: upstream?.status === 401 || error?.http_status === 401 ? "unauthorized" : "unavailable" };
    }
  }
  return account;
}
