import type { Account } from "../../apps/pool/contract.ts";
import { accountsView } from "./accounts-view.ts";
import type { HomeClient, PoolHome } from "./control.ts";
import { fail, object, unavailable, type Json } from "./json.ts";
import { hasUsageLimits, type QuotaCollection } from "./quota-collection.ts";

export async function checkAccount(
  home: PoolHome,
  client: HomeClient,
  collection: QuotaCollection,
  id: string,
  callerSignal: AbortSignal,
): Promise<Account> {
  return (await readCheckedAccount(home, client, collection, id, callerSignal)).account;
}

export async function readCheckedAccount(
  home: PoolHome,
  client: HomeClient,
  collection: QuotaCollection,
  id: string,
  callerSignal: AbortSignal,
  refresh = false,
) {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(12_000)]);
  const ids = new Set((await home.membership(signal)).members.map((member) => member.auth_id));
  if (!ids.has(id)) return fail(404, "not_found", "This subscription was removed from the pool.");
  const files = await home.credentials(signal);
  const file = files.find((entry) => entry.id === id);
  const reading =
    file && hasUsageLimits(file)
      ? refresh
        ? await collection.refresh(id, signal)
        : await collection.read(id, signal)
      : null;
  return checkedCredential(client, id, signal, files, reading);
}

/** The caller establishes pool membership or an authorized saved-account binding first. */
export async function readCredentialAccount(
  client: HomeClient,
  collection: QuotaCollection,
  id: string,
  signal: AbortSignal,
  files: Json[],
  refresh = false,
) {
  const file = files.find((entry) => entry.id === id);
  if (!file) return fail(404, "not_found", "This subscription was removed.");
  const reading = hasUsageLimits(file)
    ? refresh
      ? await collection.refresh(id, signal)
      : await collection.read(id, signal)
    : null;
  return checkedCredential(client, id, signal, files, reading);
}

async function checkedCredential(
  client: HomeClient,
  id: string,
  signal: AbortSignal,
  files: Json[],
  reading: Json | null,
) {
  const account = accountsView(files, reading ? [reading] : [], new Set([id]))[0];
  if (!account) return fail(404, "not_found", "This subscription was removed from the pool.");
  const file = files.find((file) => file.id === id)!;
  if (file.status === "error" || file.unavailable === true) {
    const runtime = await client.data(`/credentials/${encodeURIComponent(id)}/model-states`, {
      signal,
    });
    const credential = object(runtime.credential) ? runtime.credential : undefined;
    if (credential?.credential_id !== id) return unavailable();
    if (credential.refresh_blocked === true || file.status === "error") {
      const error = object(credential.last_error) ? credential.last_error : undefined;
      const upstream = object(error?.upstream) ? error.upstream : undefined;
      return {
        account: {
          ...account,
          credentialFailure:
            upstream?.status === 401 || error?.http_status === 401
              ? ("unauthorized" as const)
              : ("unavailable" as const),
        },
        quota: reading,
      };
    }
  }
  return { account, quota: reading };
}
