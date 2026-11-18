import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Planetscale from "alchemy/Planetscale";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer, Redacted } from "effect";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stackState } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/state.ts";
import { postgresUrl } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/preview-database.ts";
import { isRehearsalStage } from "../../release-barrier/release-stage.ts";
import { rehearsalFixtureStack } from "../subject.ts";

const fixture = fileURLToPath(
  new URL("../../release-preview/rehearsal-fixture-sql.ts", import.meta.url),
);

/**
 * Production's six empty policies stay dirty because the host reads those pools as not native,
 * a state no product API produces. This short-lived stack takes a role on the rehearsal's own
 * tools branch, drops those pools' native registrations once, and is destroyed with its role.
 */
export default Alchemy.Stack(
  rehearsalFixtureStack,
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Planetscale.providers(), Command.providers()),
    state: stackState,
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    if (!isRehearsalStage(stage))
      return yield* Effect.die(
        new Error("The rehearsal fixture is restricted to rehearsal stages."),
      );
    const database = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
    if (database !== `basalt-preview-${stage.slice("test-".length)}`)
      return yield* Effect.die(
        new Error("The rehearsal fixture database does not match its stage."),
      );
    // Destroy evaluates the stack without the fixture's inputs, so it declares nothing.
    const organization = yield* Config.String("REHEARSAL_ORGANIZATION").pipe(
      Config.withDefault(""),
    );
    const pools = yield* Config.String("REHEARSAL_UNREGISTERED_POOLS").pipe(Config.withDefault(""));
    if (!organization || !pools) return { stage };
    const role = yield* Planetscale.PostgresRole("RehearsalFixtureRole", {
      database,
      branch: stage,
      inheritedRoles: ["postgres"],
    });
    yield* Command.Exec("RehearsalUnregisteredPools", {
      command: `node ${fixture.slice(dirname(fixture).length + 1)}`,
      cwd: dirname(fixture),
      env: {
        DATABASE_URL: role.origin.pipe(
          Output.map((origin) => {
            const url = new URL(Redacted.value(postgresUrl(origin)));
            url.searchParams.set("options", "-c role=postgres");
            return Redacted.make(url.toString());
          }),
        ),
        REHEARSAL_ORGANIZATION: organization,
        REHEARSAL_UNREGISTERED_POOLS: pools,
      },
      memo: false,
      timeout: "1 minute",
    });
    return { stage };
  }),
);
