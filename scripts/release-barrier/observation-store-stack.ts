import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Effect } from "effect";
import { poolObservationStore } from "../../src/pool/fleet-observation.ts";
import { stackState } from "../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";

export const observationStoreStack = Stack(
  "basalt",
  {
    providers: Cloudflare.providers(),
    state: stackState,
  },
  Effect.gen(function* () {
    yield* poolObservationStore();
    // The provisioning operation preserves the full deployment's saved stack output.
    return undefined;
  }),
);
