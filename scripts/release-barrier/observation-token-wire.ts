import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import {
  assertObservationTokenEnable,
  observationTokenProps,
  type ObservationTokenManifest,
} from "./observation-token-contract.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

/** The token secret is returned directly to the SDK; only one exact creation request is admitted. */
export function observationTokenClient(
  client: HttpClient.HttpClient,
  manifest: ObservationTokenManifest,
  enable: ProvisioningEnable | undefined,
  now: () => number,
) {
  let sent = false;
  const path = `/client/v4/accounts/${manifest.accountId}/tokens`;
  return HttpClient.make((request, url) =>
    Effect.gen(function* () {
      if (
        url.origin !== "https://api.cloudflare.com" ||
        url.pathname !== path ||
        url.username ||
        url.password ||
        url.search ||
        request.method !== "POST" ||
        sent
      )
        throw provisioningRefusal(
          "observation-token-provider-operation-refused",
          "observationToken.operation",
          "one-exact-POST",
          { method: request.method, path: url.pathname },
        );
      assertObservationTokenEnable(manifest, enable, now());
      if (request.body._tag !== "Uint8Array")
        throw provisioningRefusal(
          "observation-token-body-unsupported",
          "observationToken.body",
          "JSON",
          request.body._tag,
        );
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(request.body.body));
      } catch {
        throw provisioningRefusal(
          "observation-token-body-unsupported",
          "observationToken.body",
          "JSON",
          "invalid",
        );
      }
      const props = observationTokenProps(manifest);
      const expected = {
        name: props.name,
        policies: props.policies.map((policy) => ({
          effect: policy.effect,
          permission_groups: policy.permissionGroups,
          resources: policy.resources,
        })),
      };
      sameProvisioningValue("observationToken.frozenRequest", expected, body);
      sent = true;
      return yield* client.execute(request);
    }),
  );
}
