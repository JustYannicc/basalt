import assert from "node:assert/strict";
import * as Apply from "alchemy/Apply";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { selectResources } from "alchemy/ResourceSelection";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect, Exit, Layer, Redacted } from "effect";

/** Fresh preview declarations and native scheduling, with only provider effects simulated. */
export const provePreviewConnection = (stack) =>
  Effect.gen(function* () {
    const id = "PoolModelDatabaseConnection";
    const dependencies = (node) => Object.keys(Output.upstreamAny(node.Props));
    const selected = yield* selectResources(Object.values(stack.resources), dependencies, {
      include: [id],
    });
    const isolated = {
      ...stack,
      resources: Object.fromEntries([...selected].map((id) => [id, stack.resources[id]])),
      bindings: {},
      actions: {},
      output: {},
    };
    const connection = stack.resources[id];
    const actual = yield* Provider.findProviderByType(connection.Type);
    const run = (failInitialization) =>
      Effect.gen(function* () {
        const commands = [];
        let connectionWrites = 0;
        const origin = {
          host: "fixture.invalid",
          port: 6432,
          database: "postgres",
          user: "fixture",
          password: Redacted.make("fixture"),
        };
        const attributes = {
          id: "fixture",
          name: "fixture",
          username: "fixture",
          accountId: "0".repeat(32),
          origin,
          pooledOrigin: origin,
          connectionUrl: Redacted.make("postgresql://fixture:fixture@fixture.invalid/postgres"),
          text: "fixture",
          mtlsCertificateId: "fixture",
        };
        const layers = [...new Set(Object.values(isolated.resources).map((node) => node.Type))]
          .filter((type) => type !== "Command.Exec")
          .map((type) =>
            Provider.succeed(Resource(type), {
              ...(type === connection.Type ? { diff: actual.diff, stables: actual.stables } : {}),
              reconcile: ({ news }) =>
                Effect.sync(() => {
                  if (type === connection.Type) {
                    connectionWrites++;
                    assert.ok(commands.includes("PoolDatabaseBudget"));
                    assert.ok(commands.includes("PoolDatabase"));
                    assert.equal(news.origin.database, "basalt_pool");
                  }
                  return attributes;
                }),
              delete: () => Effect.void,
            }),
          );
        layers.push(
          Command.ExecProvider().pipe(
            Layer.provide(
              Layer.succeed(Command.CommandExecutor, {
                spawn: () => Effect.die("Preview connection proof cannot spawn processes"),
                run: (props) => {
                  if (props.command === "node ensure-pool-database.ts") {
                    if (failInitialization)
                      return Effect.fail(new Error("fixture-initialization-failed"));
                    commands.push("PoolDatabase");
                  } else if (props.command === "node scripts/database-pool-budget.ts") {
                    commands.push("PoolDatabaseBudget");
                  } else return Effect.die("Unexpected preview connection Command");
                  return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
                },
              }),
            ),
          ),
        );
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            yield* Apply.apply(yield* Plan.make(isolated));
          }).pipe(
            Effect.provideService(State, InMemoryService()),
            Effect.provide(Layer.mergeAll(...layers)),
            Effect.provideContext(stack.services),
          ),
        );
        return { succeeded: Exit.isSuccess(exit), connectionWrites, commands };
      });
    return {
      dependencies: dependencies(connection).sort(),
      selected: [...selected].sort(),
      success: yield* run(false),
      failure: yield* run(true),
    };
  }).pipe(Effect.provideContext(stack.services));
