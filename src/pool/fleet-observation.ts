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
 * The account token the observation secret holds. Provisioning created this row with exactly these
 * props, so declaring them here makes a plain plan adopt it as a noop instead of orphaning it.
 * Its value is never bound: the Worker reads it from the Secrets Store.
 */
export const poolObservationToken = (accountId: string, stage: string) => {
  const token = Cloudflare.ApiToken.AccountApiToken(
    "PoolProviderObservationToken",
    poolObservationTokenProps(accountId, stage),
  );
  // Production keeps the token provisioning created; a disposable stage's token goes with the stage.
  return stage === "production" ? token.pipe(retain()) : token;
};

/** Provisioning owns the secret value; deployment binds the account store and stable name. */
export const bindPoolObservationSecret = (worker: Cloudflare.Worker) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    yield* poolObservationToken(accountId, stage);
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
