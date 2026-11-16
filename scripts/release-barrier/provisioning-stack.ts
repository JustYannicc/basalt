import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Effect } from "effect";
import { fleetInfrastructure } from "../../src/pool/fleet-deployment.ts";
import { stackState } from "../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";

/** Shared fleet declarations use the production State store. The source-plan adapter never applies this Worker. */
export const provisioningStack = Stack(
  "basalt",
  {
    providers: Cloudflare.providers(),
    state: stackState,
  },
  Effect.gen(function* () {
    const env = yield* fleetInfrastructure;
    if (!env) return undefined;
    return yield* Cloudflare.Worker("PoolWorker", {
      main: new URL("../../src/pool/worker.ts", import.meta.url).pathname,
      env: { ...env },
    });
  }),
);
