/** Delete-only provider graph for Basalt preview state; never evaluates deploy configuration. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import { Stage } from "alchemy/Stage";
import { Effect, Layer, Schema } from "effect";
import { TestStageSlug } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/stage.ts";
import { PreviousTestDatabaseCleanup } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/previous-test-database-cleanup.ts";
import {
  TestStageBuildCleanup,
  TestStageBucketCleanup,
  TestStageDomainCleanup,
} from "../../../.upstream/apps/hosted/cloud/src/infrastructure/test-stage-cleanup-providers.ts";
import { axiomProviders } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/axiom-provider.ts";

const cleanupState = Layer.unwrap(Effect.gen(function* () {
  const stage = yield* Stage;
  if (!stage.startsWith("test-pr-")) return yield* Effect.die(new Error("Preview cleanup is restricted to PR stages."));
  yield* Schema.decodeUnknownEffect(TestStageSlug)(stage.slice("test-".length)).pipe(Effect.orDie);
  return Cloudflare.state();
}));

export default Alchemy.Stack(
  "basalt",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Command.providers(),
      TestStageBuildCleanup(),
      TestStageBucketCleanup(),
      axiomProviders,
      Planetscale.providers(),
      Neon.providers(),
      TestStageDomainCleanup().pipe(Layer.provide(cleanupState)),
      PreviousTestDatabaseCleanup(),
    ),
    state: cleanupState,
  },
  Effect.succeed({}),
);
