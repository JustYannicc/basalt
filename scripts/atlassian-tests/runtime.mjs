import { Effect, Layer, Context } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { startScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { Actors } from "../../.upstream/e2e/support/actors.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { localNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { startAtlassianProvider } from "./provider.mjs";
import { loadAtlassianCatalogSource, atlassianOAuthFixtureDefinition } from "./catalog.mjs";
import { proveHostedAtlassian } from "./hosted-proof.mjs";

const [root, upstream, directory, browserExecutable, expectedSourceHash] = process.argv.slice(2);
const clientId = "synthetic-atlassian-client";
const clientSecret = "synthetic-atlassian-secret";
const require = createRequire(join(upstream, "package.json"));
const { chromium } = require("playwright");

function callbackReceiver() {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      if (request.method !== "GET" || !request.url?.startsWith("/api/oauth/callback?")) {
        response.writeHead(404); response.end(); return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Synthetic OAuth callback received");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const program = Effect.gen(function* () {
  if (!root || !upstream || !directory || !browserExecutable || !/^[a-f0-9]{64}$/.test(expectedSourceHash ?? ""))
    return yield* Effect.die(new Error("Pinned runtime and expected frozen snapshot hash are required"));
  yield* Effect.promise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* Effect.promise(() => chmod(directory, 0o700));

  const provider = yield* Effect.acquireRelease(
    Effect.promise(() => startAtlassianProvider({
      directory,
      clientId,
      clientSecret,
      scopes: ["offline_access", "read:me", "read:jira-work", "read:confluence-content.all", "search:confluence"],
    })),
    (fixture) => Effect.promise(() => fixture.stop()),
  );
  const catalogApp = yield* Effect.promise(() => loadAtlassianCatalogSource(root, expectedSourceHash, provider.origin));
  const oauth = yield* Effect.promise(() => atlassianOAuthFixtureDefinition(upstream, provider.origin));
  const callbackServer = yield* Effect.acquireRelease(Effect.promise(callbackReceiver), (server) => Effect.promise(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }));
  const callback = `http://127.0.0.1:${callbackServer.address().port}/api/oauth/callback`;
  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ headless: true, executablePath: browserExecutable })),
    (instance) => Effect.promise(() => instance.close()),
  );

  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* localNpmRegistry;
  const target = yield* startScenario(base.target, "Atlassian hosted OAuth and MCP isolation proof", undefined, {
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_OAUTH_CALLBACK_URL: callback,
    EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([oauth.definition]),
    EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID: "",
    EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET: "",
    EXECUTOR_OAUTH_ATLASSIAN_LOCAL_PROOF_CLIENT_ID: clientId,
    EXECUTOR_OAUTH_ATLASSIAN_LOCAL_PROOF_CLIENT_SECRET: clientSecret,
  });
  const services = yield* Layer.build(Actors.layer.pipe(
    Layer.provideMerge(SessionClients.layer),
    Layer.provideMerge(Layer.succeed(Target, target)),
  ));
  const actors = Context.get(services, Actors);
  const sessionsApi = Context.get(services, SessionClients);
  const proof = yield* proveHostedAtlassian({
    root,
    directory,
    upstream,
    target,
    actors,
    sessionsApi,
    browser,
    callback,
    provider,
    catalogApp,
    oauthDefinition: oauth.definition,
    protectedHome: process.env.ATLASSIAN_PROTECTED_HOME,
  });
  return {
    ...proof,
    checks: proof.checks,
    actualCatalogApp: catalogApp.packageName,
    catalogSourceSha256: catalogApp.sourceHash,
    catalogProvenance: catalogApp.provenance,
    endpointOverrides: catalogApp.overrides,
    syntheticProvider: true,
    publishedAtlassianEmulator: false,
    officialAtlassianEndToEnd: false,
    BasaltPoolAppAccess: false,
  };
});

await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
try {
  const result = await Effect.runPromise(program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ));
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Atlassian runtime proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
