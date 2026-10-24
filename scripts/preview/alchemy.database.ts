import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer } from "effect";
import { adopt } from "alchemy/AdoptPolicy";
import { stackState } from "../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";

/** A clean PlanetScale database belongs to one PR and is destroyed after its app branches. */
export default Alchemy.Stack(
  "basalt-preview-database",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Planetscale.providers()),
    state: stackState,
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const match = /^test-pr-([1-9][0-9]*)$/.exec(stage);
    if (!match) return yield* Effect.die(new Error("Preview database stack is restricted to PR stages."));
    const expected = `basalt-preview-pr-${match[1]}`;
    const databaseName = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
    if (databaseName !== expected)
      return yield* Effect.die(new Error("Preview database name does not match its PR stage."));
    const database = yield* Planetscale.PostgresDatabase("PreviewDatabaseParent", {
      name: databaseName,
      clusterSize: yield* Config.NonEmptyString("PLANETSCALE_CLUSTER_SIZE"),
      region: { slug: yield* Config.NonEmptyString("PLANETSCALE_REGION") },
    }).pipe(adopt(false));
    return { databaseName: database.name };
  }),
);
