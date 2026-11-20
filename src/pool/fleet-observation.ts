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

/** The standing rehearsal stages, exactly. Their names stay short enough to keep the stage token. */
export const rehearsalObservationStage = /^test-rehearsal-[1-9]$/u;

/**
 * REHEARSAL-ONLY: a standing rehearsal stage mints its own observation token (the same props as
 * production's: Workers Containers Read on the account, nothing writable) and binds its value to
 * the pool Worker as a plain secret. The reader takes a string as it takes the store binding, so
 * nothing about the reads changes. Nothing is written to the account's Secrets Store, which
 * production uses. Refuses on any other stage.
 */
export const bindRehearsalObservationToken = (worker: Cloudflare.Worker) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    if (!rehearsalObservationStage.test(stage))
      return yield* Effect.die(
        new Error(
          "Only a test-rehearsal-<1-9> stage binds its observation token as a plain secret",
        ),
      );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const token = yield* poolObservationToken(accountId, stage);
    yield* worker.bind("pool-provider-observation", {
      env: { POOL_PROVIDER_OBSERVATION_TOKEN: token.value },
    });
  });

/**
 * Production binds on every deploy, fleet or not, so no plan can drop POOL_PROVIDER_OBSERVATION_TOKEN.
 * A standing rehearsal stage binds its own token as a plain secret, fleet or not. Other stages bind
 * once they declare a fleet.
 */
export const bindPoolObservation = (worker: Cloudflare.Worker, fleetDeclared: boolean) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    if (rehearsalObservationStage.test(stage)) yield* bindRehearsalObservationToken(worker);
    else if (fleetDeclared || stage === "production") yield* bindPoolObservationSecret(worker);
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
