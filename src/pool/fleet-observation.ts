import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Redacted } from "effect";

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
 * REHEARSAL-ONLY: a standing rehearsal stage binds an observation token the operator minted for it
 * (the same props as production's: Workers Containers Read on the account, nothing writable) as a
 * plain Worker secret. The deploy credential cannot mint tokens, and the account's one Secrets
 * Store is production's, so the value arrives as the stage job's own secret. Until one exists the
 * stage says so explicitly (`POOL_REHEARSAL_OBSERVATION=absent`) and binds nothing; neither, or
 * both, refuses. Refuses on any other stage.
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
    const token = yield* Config.Redacted("POOL_REHEARSAL_OBSERVATION_TOKEN").pipe(Config.option);
    const absent = yield* Config.String("POOL_REHEARSAL_OBSERVATION").pipe(Config.option);
    const declaredAbsent = Option.isSome(absent) && absent.value === "absent";
    if (Option.isSome(absent) && !declaredAbsent)
      return yield* Effect.die(new Error("POOL_REHEARSAL_OBSERVATION may only be absent"));
    if (Option.isSome(token) && Redacted.value(token.value).trim() !== "") {
      if (declaredAbsent)
        return yield* Effect.die(
          new Error("A rehearsal stage has its observation token and also declares it absent"),
        );
      yield* worker.bind("pool-provider-observation", {
        env: { POOL_PROVIDER_OBSERVATION_TOKEN: token.value },
      });
      return;
    }
    if (!declaredAbsent)
      return yield* Effect.die(
        new Error(
          "A rehearsal stage needs its observation token (REHEARSAL_OBSERVATION_TOKEN_<N>) or POOL_REHEARSAL_OBSERVATION=absent",
        ),
      );
  }).pipe(Effect.orDie);

/**
 * Production binds on every deploy, fleet or not, so no plan can drop POOL_PROVIDER_OBSERVATION_TOKEN.
 * A standing rehearsal stage binds its operator-minted token as a plain secret, fleet or not. Other stages bind
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
