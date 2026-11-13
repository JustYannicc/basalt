import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";

export const poolObservationPermission = "cfd39eebc07c4e3ea849e4b3d2644637";
export const poolObservationSecretName = (stage: string) =>
  `basalt-${stage}-pool-provider-observation`;

/** Provisioning owns the value; deployment only binds its account store and stable name. */
export const bindPoolObservationSecret = (worker: Cloudflare.Worker) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    const store = yield* Cloudflare.SecretsStore.Store("PoolObservationSecrets").pipe(retain());
    yield* worker.bind("pool-provider-observation", {
      bindings: [
        {
          type: "secrets_store_secret",
          name: "POOL_PROVIDER_OBSERVATION_TOKEN",
          storeId: store.storeId,
          secretName: poolObservationSecretName(stage),
        },
      ],
    });
  });

export function poolObservationTokenProps(accountId: string, stage: string) {
  return {
    accountId,
    name: poolObservationSecretName(stage),
    policies: [
      {
        effect: "allow" as const,
        permissionGroups: [{ id: poolObservationPermission }],
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
      },
    ],
  };
}
