import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Effect } from "effect";
import { stackState } from "../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";
import { stackNameForStage } from "./release-stage.ts";

/** Settlement observes saved resources directly and never plans a deployment declaration. */
export const releaseStateStack = Stack(
  stackNameForStage(process.env.ALCHEMY_STAGE),
  { providers: Cloudflare.providers(), state: stackState },
  Effect.succeed(undefined),
);
