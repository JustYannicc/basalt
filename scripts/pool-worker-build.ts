import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { Effect, Layer, type FileSystem, type Path } from "effect";
import { fileURLToPath } from "node:url";

// Match the pinned provider's deploy bundler, including Cloudflare's runtime plugins.
const entry = import.meta.resolve("alchemy");
const module = new URL(
  `Cloudflare/Workers/Sources/Rolldown${entry.endsWith(".ts") ? ".ts" : ".js"}`,
  new URL("./", entry),
);
const { WorkerBundle }: {
  readonly WorkerBundle: Effect.Effect<
    { readonly build: (options: object) => Effect.Effect<unknown, Error> },
    never,
    FileSystem.FileSystem | Path.Path
  >;
} = await import(module.href);
const program = Effect.gen(function* () {
  const bundler = yield* WorkerBundle;
  // Every owned Worker uses the same provider bundler as deployment.
  for (const [id, entrypoint] of [
    ["PoolWorker", "../src/pool/worker.ts"],
    ["Catalog", "../src/catalog/worker.ts"],
    ["Router", "../src/router.ts"],
  ]) {
    yield* bundler.build({
      id,
      main: fileURLToPath(new URL(entrypoint, import.meta.url)),
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      entry: { kind: "external" },
      stack: { name: "basalt", stage: "production" },
      extraOptions: undefined,
    });
  }
});
NodeRuntime.runMain(program.pipe(
  Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
));
