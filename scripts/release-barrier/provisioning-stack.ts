import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";
import { fleetInfrastructure } from "../../src/pool/fleet-deployment.ts";
import { stackState } from "../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";
import { stackNameForStage } from "./release-stage.ts";

/** The declarations a bootstrap reads; tests evaluate this same body against in-memory state. */
export const provisioningDeclarations = Effect.gen(function* () {
  const env = yield* fleetInfrastructure;
  if (!env) return undefined;
  return yield* Cloudflare.Worker("PoolWorker", {
    main: new URL("../../src/pool/worker.ts", import.meta.url).pathname,
    env: { ...env },
  });
});

/** Shared fleet declarations use the production State store. The source-plan adapter never applies this Worker. */
export const provisioningStack = Stack(
  stackNameForStage(process.env.ALCHEMY_STAGE),
  {
    providers: Cloudflare.providers(),
    state: stackState,
  },
  Effect.gen(function* () {
    if (stackNameForStage(yield* Stage) !== stackNameForStage(process.env.ALCHEMY_STAGE))
      return yield* Effect.die(new Error("The release stage and ALCHEMY_STAGE name different stacks."));
    return yield* provisioningDeclarations;
  }),
);
