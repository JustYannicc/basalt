import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Effect } from "effect";
import { fleetBindings, fleetInfrastructure } from "../../src/pool/fleet-deployment.ts";
import { stackState } from "../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";

/** The declarations a bootstrap reads; tests evaluate this same body against in-memory state. */
export const provisioningDeclarations = Effect.gen(function* () {
  const env = yield* fleetInfrastructure;
  if (!env) return undefined;
  return yield* Cloudflare.Worker("PoolWorker", {
    main: new URL("../../src/pool/worker.ts", import.meta.url).pathname,
    // This Worker is only evaluated for the bootstrap's source plan, never applied. It mirrors
    // src/pool/deployment.ts so that plan never shows a fleet class being deleted.
    env: fleetBindings(env),
  });
});

/** Shared fleet declarations use the production State store. The source-plan adapter never applies this Worker. */
export const provisioningStack = Stack(
  "basalt",
  {
    providers: Cloudflare.providers(),
    state: stackState,
  },
  provisioningDeclarations,
);
