import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const scratch = process.argv[2];
process.chdir(scratch);
symlinkSync(
  fileURLToPath(new URL("../../node_modules", import.meta.url)),
  join(scratch, "node_modules"),
  "dir",
);
writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
const main = join(scratch, "main.js");
writeFileSync(main, 'export default { fetch() { return new Response("frozen"); } };');
const calls = [];
const account = "0".repeat(32),
  script = "fixture-worker";
let metadata;
let encodedVersion;
const envelope = (result) => Response.json({ success: true, errors: [], messages: [], result });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const suffix = url.pathname.replace(`/client/v4/accounts/${account}/workers`, "");
  calls.push(`${request.method}:${suffix}`);
  if (request.method === "GET" && suffix === `/scripts/${script}/settings`)
    return envelope({ bindings: [], tags: [], logpush: false });
  if (request.method === "GET" && suffix === `/scripts/${script}/subdomain`)
    return envelope({ enabled: false, previews_enabled: false });
  if (request.method === "GET" && suffix === `/scripts/${script}/schedules`)
    return envelope({ schedules: [] });
  if (request.method === "GET" && suffix === "/domains") return envelope([]);
  if (request.method === "PUT" && suffix === `/scripts/${script}`) {
    const form = await request.formData();
    const part = form.get("metadata");
    metadata = JSON.parse(typeof part === "string" ? part : await part.text());
    return envelope({ id: script, tag: "immutable-worker", startup_time_ms: 10, logpush: false });
  }
  if (request.method === "POST" && suffix === `/scripts/${script}/versions`) {
    const form = await request.formData();
    const part = form.get("metadata");
    encodedVersion = {
      metadata: JSON.parse(typeof part === "string" ? part : await part.text()),
      inherit: url.searchParams.get("bindings_inherit"),
    };
    return envelope({ id: "accepted-version", resources: { bindings: [] }, startup_time_ms: 100 });
  }
  if (request.method === "POST" && suffix === `/scripts/${script}/deployments`) {
    const body = await request.json();
    return envelope({
      id: "exact-deployment",
      source: "api",
      created_on: "2026-01-01T00:00:00Z",
      strategy: "percentage",
      versions: body.versions,
    });
  }
  throw new Error(`Unexpected fixture API operation ${request.method}:${suffix}`);
};
const [
  { Effect, Layer, ConfigProvider, Context, Exit, Cause },
  Cloudflare,
  { Stack, evalStack },
  { inMemoryState, State },
  { WorkerUploadHook },
  { withReleaseRuntime },
  { attributes },
  { findProvider },
  { scopedArtifacts },
  Workers,
  Retry,
  { uploadRequest },
] = await Promise.all([
  import("effect"),
  import("alchemy/Cloudflare"),
  import("alchemy/Stack"),
  Promise.all([import("alchemy/State/InMemoryState"), import("alchemy/State/State")]).then(
    ([a, b]) => ({ ...a, ...b }),
  ),
  import("alchemy/Cloudflare/Workers/WorkerUploadHook"),
  import("./runtime.ts"),
  import("./fixture.ts"),
  import("alchemy/Provider"),
  import("alchemy/Artifacts"),
  import("@distilled.cloud/cloudflare/workers"),
  import("@distilled.cloud/cloudflare/Retry"),
  import("./version-request.ts"),
]);
const settings = {
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: "fixture-token",
  ALCHEMY_STAGE: "production",
};
const program = (useHook) =>
  evalStack(
    Stack(
      "fixture",
      { providers: Cloudflare.providers(), state: inMemoryState() },
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("Fixture", {
          main,
          workersDev: false,
          compatibility: { date: "2026-09-08" },
        });
      }),
    ),
    (compiled) =>
      Effect.gen(function* () {
        if (useHook === "version") {
          yield* Workers.createScriptVersion(
            uploadRequest({
              id: "Fixture",
              accountId: account,
              scriptName: script,
              baseline: [{ versionId: "old", percentage: 100 }],
              metadata: {
                mainModule: "main.js",
                keepAssets: true,
                assets: {
                  config: {
                    headers: "/assets/*\n X-Fixture: preserved",
                    redirects: "/old /new 301",
                    runWorkerFirst: ["/api/*"],
                  },
                },
              },
              files: [
                {
                  name: "main.js",
                  type: "application/javascript+module",
                  bytes: new TextEncoder().encode("export default {}"),
                },
              ],
            }),
          );
          return encodedVersion;
        }
        const provider = yield* findProvider(Cloudflare.Worker);
        const input = {
          id: "Fixture",
          fqn: "Fixture",
          instanceId: "fixture-instance",
          news: { main, workersDev: false, compatibility: { date: "2026-09-08" } },
          olds: {},
          bindings: [],
          output: { ...attributes("Fixture"), accountId: account, workerName: script },
          session: { note: () => Effect.void, emit: () => Effect.void },
        };
        let captured;
        const reconcile = provider.reconcile(input);
        yield* useHook
          ? reconcile.pipe(
              Effect.provideService(WorkerUploadHook, {
                capture: (upload) =>
                  Effect.sync(() => {
                    captured = upload;
                    return upload.proposed;
                  }),
              }),
            )
          : reconcile;
        const before = [...calls];
        if (captured) {
          const frozen = awaitFiles(captured.request.files);
          const files = yield* Effect.promise(() => frozen);
          writeFileSync(main, 'throw new Error("must not rebuild this changed source");');
          const output = yield* captured.activate("accepted-version");
          return {
            before,
            after: [...calls],
            files,
            versionId: output.versionId,
            deploymentId: output.deploymentId,
            frozenHash: captured.proposed.hash.bundle,
            activatedHash: output.hash.bundle,
          };
        }
        return { before, after: [...calls], mainModule: metadata?.main_module };
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
function awaitFiles(raw) {
  return Promise.all(
    (Array.isArray(raw) ? raw : [raw]).map(async (file) => ({
      name: file.name,
      bytes: file.size,
      hasFrozen: (await file.text()).includes("frozen"),
    })),
  );
}
const hook = await Effect.runPromiseExit(program(true));
if (Exit.isFailure(hook)) {
  console.error(Cause.pretty(hook.cause));
  process.exit(1);
}
writeFileSync(main, 'export default { fetch() { return new Response("ordinary"); } };');
calls.length = 0;
const ordinary = await Effect.runPromiseExit(program(false));
if (Exit.isFailure(ordinary)) {
  console.error(Cause.pretty(ordinary.cause));
  process.exit(1);
}
const version = await Effect.runPromiseExit(program("version"));
if (Exit.isFailure(version)) {
  console.error(Cause.pretty(version.cause));
  process.exit(1);
}
console.log(
  "__PROOF__" +
    JSON.stringify({ hook: hook.value, ordinary: ordinary.value, version: version.value }),
);
