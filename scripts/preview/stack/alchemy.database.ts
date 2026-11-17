import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer } from "effect";
import { adopt } from "alchemy/AdoptPolicy";
import { stackState } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";
import { stageNames, subjectFromStage } from "../subject.ts";

/**
 * A clean PlanetScale database belongs to one PR or rehearsal and is destroyed after its app
 * branches. Both kinds share this stack name; the stage keeps their state apart.
 */
export default Alchemy.Stack(
  "basalt-preview-database",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Planetscale.providers()),
    state: stackState,
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const subject = subjectFromStage(stage);
    if (!subject)
      return yield* Effect.die(new Error("Preview database stack is restricted to PR and rehearsal stages."));
    const databaseName = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
    if (databaseName !== stageNames(subject).databaseName)
      return yield* Effect.die(new Error("Preview database name does not match its stage."));
    const database = yield* Planetscale.PostgresDatabase("PreviewDatabaseParent", {
      name: databaseName,
      clusterSize: yield* Config.NonEmptyString("PLANETSCALE_CLUSTER_SIZE"),
      region: { slug: yield* Config.NonEmptyString("PLANETSCALE_REGION") },
    }).pipe(adopt(false));
    return { databaseName: database.name };
  }),
);
