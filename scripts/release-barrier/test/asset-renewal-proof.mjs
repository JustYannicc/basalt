import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const scratch = process.argv[2];
process.chdir(scratch);
symlinkSync(
  fileURLToPath(new URL("../../../node_modules", import.meta.url)),
  join(scratch, "node_modules"),
  "dir",
);
writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
const main = join(scratch, "main.js");
writeFileSync(main, 'export default { fetch() { return new Response("frozen"); } };');
const directory = join(scratch, "public");
mkdirSync(directory);
writeFileSync(join(directory, "logo.txt"), "frozen asset");
const calls = [];
const manifests = [];
const account = "0".repeat(32),
  script = "fixture-worker";
const envelope = (result) => Response.json({ success: true, errors: [], messages: [], result });
// Cloudflare's session contract: the first session asks for the missing file; once every file
// is stored, a new session returns a completion token directly.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const suffix = url.pathname.replace(`/client/v4/accounts/${account}/workers`, "");
  calls.push(`${request.method}:${suffix}`);
  if (request.method === "GET" && suffix === `/scripts/${script}/settings`)
    return envelope({ bindings: [], tags: [], logpush: false });
  if (request.method === "POST" && suffix === `/scripts/${script}/assets-upload-session`) {
    const { manifest } = await request.json();
    manifests.push(manifest);
    const hashes = Object.values(manifest).map((entry) => entry.hash);
    return manifests.length === 1
      ? envelope({ jwt: "upload-token", buckets: [hashes] })
      : envelope({ jwt: `completion-${manifests.length}`, buckets: [] });
  }
  if (request.method === "POST" && suffix === "/assets/upload")
    return envelope({ jwt: "completion-1" });
  throw new Error(`Unexpected fixture API operation ${request.method}:${suffix}`);
};
const [
  { Effect, ConfigProvider, Context, Exit, Cause },
  Cloudflare,
  { Stack, evalStack },
  { inMemoryState, State },
  { WorkerUploadHook },
  { withReleaseRuntime },
  { attributes },
  { findProvider },
  { scopedArtifacts },
  Retry,
] = await Promise.all([
  import("effect"),
  import("alchemy/Cloudflare"),
  import("alchemy/Stack"),
  Promise.all([import("alchemy/State/InMemoryState"), import("alchemy/State/State")]).then(
    ([a, b]) => ({ ...a, ...b }),
  ),
  import("alchemy/Cloudflare/Workers/WorkerUploadHook"),
  import("../runtime.ts"),
  import("../fixture.ts"),
  import("alchemy/Provider"),
  import("alchemy/Artifacts"),
  import("@distilled.cloud/cloudflare/Retry"),
]);
const settings = {
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: "fixture-token",
  ALCHEMY_STAGE: "production",
};
const props = {
  main,
  assets: { directory },
  workersDev: false,
  compatibility: { date: "2026-09-08" },
};
const program = evalStack(
  Stack(
    "fixture",
    { providers: Cloudflare.providers(), state: inMemoryState() },
    Effect.gen(function* () {
      return yield* Cloudflare.Worker("Fixture", props);
    }),
  ),
  (compiled) =>
    Effect.gen(function* () {
      const provider = yield* findProvider(Cloudflare.Worker);
      let captured;
      yield* provider
        .reconcile({
          id: "Fixture",
          fqn: "Fixture",
          instanceId: "fixture-instance",
          news: props,
          olds: {},
          bindings: [],
          output: { ...attributes("Fixture"), accountId: account, workerName: script },
          session: { note: () => Effect.void, emit: () => Effect.void },
        })
        .pipe(
          Effect.provideService(WorkerUploadHook, {
            capture: (upload) =>
              Effect.sync(() => {
                captured = upload;
                return upload.proposed;
              }),
          }),
        );
      // Startup admission renews after the provider's reconcile has returned.
      const frozen = captured.request.metadata.assets?.jwt;
      const renewed = [yield* captured.renewAssets(), yield* captured.renewAssets()];
      return { frozen, renewed, manifests, calls: [...calls] };
    }).pipe(
      Effect.provide(scopedArtifacts("Fixture")),
      Effect.provideContext(compiled.services),
      Effect.provideService(State, Context.get(compiled.services, State)),
    ),
  { stage: "production" },
).pipe(
  withReleaseRuntime,
  Retry.none,
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: settings }))),
);
const exit = await Effect.runPromiseExit(program);
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
console.log(`__PROOF__${JSON.stringify(exit.value)}`);
