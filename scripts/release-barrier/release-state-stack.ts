import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Effect } from "effect";
import { stackState } from "../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";

/** Settlement observes saved resources directly and never plans a deployment declaration. */
export const releaseStateStack = Stack(
  "basalt",
  { providers: Cloudflare.providers(), state: stackState },
  Effect.succeed(undefined),
);
