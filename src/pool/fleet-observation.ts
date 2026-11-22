import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";

export const poolObservationPermission = "cfd39eebc07c4e3ea849e4b3d2644637";
export const poolObservationSecretName = (stage: string) =>
  `basalt-${stage}-pool-provider-observation`;

export const poolObservationStore = () =>
  Cloudflare.SecretsStore.Store("PoolObservationSecrets", {}).pipe(retain());

/**
 * The operator's credential bootstrap owns the account token and writes its value into the store
 * (scripts/pool-credential-bootstrap.ts); deployment binds the account store and stable name. No
 * stack declares the token: production's State never held one, so a declaration would mint a new
 * account token whose value nothing stores.
 */
export const bindPoolObservationSecret = (worker: Cloudflare.Worker) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    const store = yield* poolObservationStore();
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

/**
 * Production binds on every deploy, fleet or not, so no plan can drop POOL_PROVIDER_OBSERVATION_TOKEN.
 * Other stages bind once they declare a fleet.
 */
export const bindPoolObservation = (worker: Cloudflare.Worker, fleetDeclared: boolean) =>
  Effect.gen(function* () {
    if (fleetDeclared || (yield* Stage) === "production") yield* bindPoolObservationSecret(worker);
  });

/** The read-only account token the bootstrap mints: Containers Read on the deployment account. */
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
