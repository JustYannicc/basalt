import type { CompiledStack } from "alchemy/Stack";
import { loginWithCloudflare, CloudflareApiLive } from "alchemy/Cloudflare";
import { currentProfileName } from "alchemy/Auth/Profile";
import { makeReadOnlyHttpStateStore } from "alchemy/State/ReadOnlyHttpStateStore";
import { Cause, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { retiredPlacements } from "./placement-retirement.ts";
import {
  candidateReadFailure,
  CandidateSettingsReadFailure,
  type CandidateStage,
} from "./candidate-failure.ts";

const boundary =
  (stage: CandidateStage) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) => Effect.fail(candidateReadFailure(Cause.squash(cause), stage))),
    );

/** Credentials lookup never initializes State. Only the existing public version endpoint is read. */
export const readExistingStateContract = (stack: CompiledStack, fetcher: typeof fetch) =>
  Effect.gen(function* () {
    const credentials = yield* loginWithCloudflare(yield* currentProfileName, false).pipe(
      boundary("retirement-auth"),
    );
    const version = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetcher(new URL("/version", credentials.url), {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status !== 200)
          throw new CandidateSettingsReadFailure(
            "retirement-version",
            "StateStoreError",
            undefined,
            "retirement-state-version-unavailable",
            { status: response.status },
          );
        return Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Number }))(
          await response.json(),
        ).version;
      },
      catch: (error) => error,
    }).pipe(boundary("retirement-version"));
    return { credentials, version };
  }).pipe(
    Effect.provide(CloudflareApiLive()),
    Effect.provideContext(stack.services),
    Effect.provideService(FetchHttpClient.Fetch, fetcher),
    boundary("retirement-auth"),
  );

/** v8 adds scoped-reader authorization; full-token State GETs use the same contract in v7. */
export const readPlacementRetirements = (stack: CompiledStack, fetcher: typeof fetch) =>
  Effect.gen(function* () {
    const { credentials, version } = yield* readExistingStateContract(stack, fetcher);
    if (version !== 7 && version !== 8)
      return yield* Effect.fail(
        new CandidateSettingsReadFailure(
          "retirement-version",
          "StateStoreError",
          undefined,
          "retirement-state-version-unsupported",
          { observedVersion: version },
        ),
      );
    const state = yield* makeReadOnlyHttpStateStore({
      url: credentials.url,
      authToken: Redacted.make(credentials.authToken),
      stack: `${stack.name}-placement-repair`,
      stage: stack.stage,
      expectedVersion: version,
    }).pipe(boundary("retirement-state"));
    return yield* retiredPlacements(state, stack).pipe(boundary("retirement-output"));
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetcher));
