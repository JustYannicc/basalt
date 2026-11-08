import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildStateWorker(directory) {
  const entry = import.meta.resolve("alchemy");
  const bundlerModule = new URL("Cloudflare/Workers/Sources/Rolldown.js", new URL("./", entry));
  const compatibilityModule = new URL("Cloudflare/Workers/Compatibility.js", new URL("./", entry));
  const [{ WorkerBundle }, { getCompatibility }] = await Promise.all([
    import(bundlerModule.href),
    import(compatibilityModule.href),
  ]);
  const main = fileURLToPath(new URL("Cloudflare/StateStore/Api.js", new URL("./", entry)));
  if (!/STATE_STORE_VERSION\s*=\s*8\s*;/.test(readFileSync(main, "utf8")))
    throw new Error("State Worker source must declare version 8");
  // Match Alchemy's Worker provider, as the existing worker-size build does.
  // Only the installed bundler internals are loaded; no deploy or State service runs.
  const compatibility = getCompatibility({ main });
  await Effect.runPromise(
    Effect.gen(function* () {
      const bundler = yield* WorkerBundle;
      yield* bundler.build({
        id: "StateStoreUpgrade",
        main,
        compatibility,
        entry: { kind: "effect", exports: { Store: { kind: "durableObject" } } },
        stack: { name: "CloudflareStateStore", stage: "alchemy-state-store" },
      });
    }).pipe(
      Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
      Effect.provide(NodeServices.layer),
    ),
  );
  return { directory: resolve(directory, "bundles/StateStoreUpgrade"), compatibility };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Supply a fresh build output directory");
  const result = await buildStateWorker(resolve(process.argv[2]));
  const files = readdirSync(result.directory).filter((name) => name.endsWith(".js"));
  if (!files.includes("Api.js")) throw new Error("State Worker entry is missing");
  writeFileSync(
    resolve(result.directory, "upgrade-bundle.json"),
    JSON.stringify({ main: "Api.js", files, compatibility: result.compatibility }) + "\n",
  );
}
