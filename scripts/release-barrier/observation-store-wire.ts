import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { provisioningRefusal } from "./provisioning-refusal.ts";

/** Provider traffic can only list this account's stores. State-store traffic uses its captured client. */
export function observationStoreClient(client: HttpClient.HttpClient, accountId: string) {
  let count = 0;
  return HttpClient.make((request, url) =>
    Effect.gen(function* () {
      if (
        request.method !== "GET" ||
        url.origin !== "https://api.cloudflare.com" ||
        url.pathname !== `/client/v4/accounts/${accountId}/secrets_store/stores` ||
        url.username ||
        url.password ||
        url.hash ||
        [...url.searchParams].some(
          ([key, value]) => !["page", "per_page"].includes(key) || !/^[1-9][0-9]*$/u.test(value),
        ) ||
        ++count > 8
      )
        throw provisioningRefusal(
          "observation-store-provider-operation-refused",
          "observationStore.request",
          "bounded-account-store-GET",
          { method: request.method, path: url.pathname },
        );
      return yield* client.execute(request);
    }),
  );
}
