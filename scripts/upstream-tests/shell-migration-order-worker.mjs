import { Stack, evalStack } from "alchemy/Stack";
import * as Output from "alchemy/Output";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { layerNonInteractive } from "alchemy/Interaction";
import { ConfigProvider, Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Declaration evaluation must never execute a provider or make a service request.
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const { cloudSiteAfterMigrations } = await import(pathToFileURL(resolve(
  ".upstream/apps/hosted/cloud/src/infrastructure/site-release.ts",
)).href);
const dev = process.argv[2] === "dev";
const context = Layer.succeed(AlchemyContext, {
  dotAlchemy: process.env.ORDER_FIXTURE_DIRECTORY,
  dev,
  adopt: false,
});
const stack = Stack("shell-order", { providers: Layer.empty, state: Layer.empty }, Effect.gen(function* () {
  return yield* cloudSiteAfterMigrations;
}));
const names = await Effect.runPromise(evalStack(stack, (stack) => Effect.sync(() =>
  Object.values(Output.upstreamAny(stack.output.hash)).map(resource => resource.LogicalId).sort(),
), { stage: "fixture", dev }).pipe(
  provideFreshArtifactStore,
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {
    BETTER_AUTH_URL: "https://fixture.invalid",
    BETTER_AUTH_SECRET: "a".repeat(64),
    PLANETSCALE_DATABASE_NAME: "fixture",
    PLANETSCALE_CLUSTER_SIZE: "PS_10",
    PLANETSCALE_REGION: "eu-west-1",
  } }))),
  Effect.provide(layerNonInteractive()),
  Effect.provide(context.pipe(Layer.provideMerge(NodeServices.layer))),
));
process.stdout.write(JSON.stringify(names));
