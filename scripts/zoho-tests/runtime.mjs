import assert from "node:assert/strict";
import { Effect, Layer, Context, ConfigProvider, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
import {
  boundedFailure,
  digest,
  pinProofSource,
} from "./evidence.mjs";
import {
  loadZohoCatalogSource,
  localZohoOAuthDefinition,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_SCOPES,
  ZOHO_SNAPSHOT_PATH,
  ZOHO_SNAPSHOT_SHA256,
} from "./catalog.mjs";
import { startZohoProvider } from "./provider.mjs";
import { proveZohoHosted } from "./hosted-proof.mjs";

const [root, upstream, directory, browserExecutable, proofPinPath] = process.argv.slice(2);
const privateValues = [ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET];
let provider;
let stage = "preflight";

function callbackReceiver() {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      if (request.method !== "GET" || !request.url?.startsWith("/api/oauth/callback?")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const callback = new URL(request.url, "http://127.0.0.1");
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Synthetic OAuth callback received");
      server.lastCallback = {
        codePresent: Boolean(callback.searchParams.get("code")),
        statePresent: Boolean(callback.searchParams.get("state")),
      };
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const writeJsonExclusive = async (path, value) => {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
};

const program = Effect.gen(function* () {
  assert.ok(root && upstream && directory && browserExecutable && proofPinPath,
    "Pinned Zoho runtime proof inputs are required");
  process.chdir(upstream);
  yield* Effect.promise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* Effect.promise(() => chmod(directory, 0o700));
  const proofPin = JSON.parse(yield* Effect.promise(() => readFile(proofPinPath, "utf8")));
  assert.equal(proofPin.snapshotPath, ZOHO_SNAPSHOT_PATH);
  assert.equal(proofPin.snapshotSha256, ZOHO_SNAPSHOT_SHA256);
  const preflight = pinProofSource(root, proofPin.candidateCommit, proofPin.baseCommit);
  assert.deepEqual(preflight, proofPin.sourcePin, "Candidate or prepared runtime changed before native proof");

  stage = "write invocation before runtime";
  const expectedSource = yield* Effect.promise(() => readFile(ZOHO_SNAPSHOT_PATH));
  assert.equal(digest(expectedSource), ZOHO_SNAPSHOT_SHA256, "Official Zoho snapshot changed before runtime");
  yield* Effect.promise(() => writeJsonExclusive(join(directory, "invocation.json"), {
    candidateCommit: proofPin.candidateCommit,
    baseCommit: proofPin.baseCommit,
    candidateTree: proofPin.sourcePin.candidateTree,
    runtimeCommit: proofPin.sourcePin.runtimeCommit,
    patches: proofPin.sourcePin.patches,
    officialSnapshot: { path: ZOHO_SNAPSHOT_PATH, sha256: ZOHO_SNAPSHOT_SHA256 },
    product: "normal public self-host runtime from .upstream",
    setup: [
      "create an isolated organization through the public self-host sign-up and invitation APIs",
      "deploy the unchanged official Zoho CRM source with only recorded loopback and apps SDK adaptations",
      "connect two actors using synthetic Zoho OAuth accounts",
      "check each account health through the public API",
      "use native MCP search, describe, and read-only call",
    ],
    nativeMcpPlan: {
      search: { tool: "search", query: "the slug returned by the public deploy response" },
      describe: { tool: "describe", path: "the search result whose path ends in getRecords" },
      call: {
        tool: "call",
        input: { accountId: "the caller's account ID", input: { module: "Leads", fields: "Last_Name" } },
      },
      peerAccountCall: {
        tool: "call",
        input: { accountId: "the peer's native account ID", input: { module: "Leads", fields: "Last_Name" } },
      },
      unsupportedAccountsSelection: {
        tool: "call",
        input: { $accounts: { zoho: "the peer's native account ID" } },
      },
    },
  }));

  stage = "start loopback fixtures";
  const callbackServer = yield* Effect.acquireRelease(
    Effect.promise(callbackReceiver),
    server => Effect.promise(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }),
  );
  const callback = "http://127.0.0.1:" + callbackServer.address().port + "/api/oauth/callback";
  provider = yield* Effect.acquireRelease(
    Effect.promise(() => startZohoProvider({
      clientId: ZOHO_CLIENT_ID,
      clientSecret: ZOHO_CLIENT_SECRET,
      scopes: ZOHO_SCOPES,
    })),
    fixture => Effect.promise(() => fixture.stop()),
  );
  privateValues.push(...provider.privateValues);

  stage = "match hosted regional clients and adapt official snapshot";
  const require = createRequire(join(upstream, "package.json"));
  const hostedOAuth = yield* Effect.promise(() => import(pathToFileURL(join(
    upstream,
    "apps/hosted/server/src/implementation/first-party-oauth.ts",
  )).href));
  const regionalDefinitions = hostedOAuth.firstPartyOAuthClientDefinitions;
  const configured = yield* Effect.promise(() => Effect.runPromise(
    hostedOAuth.firstPartyOAuthClients({ testDefinitions: false }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
        EXECUTOR_PRODUCT_NAME: "Signalbox",
        EXECUTOR_OAUTH_ZOHO_CLIENT_ID: ZOHO_CLIENT_ID,
        EXECUTOR_OAUTH_ZOHO_CLIENT_SECRET: ZOHO_CLIENT_SECRET,
      })),
    ),
  ));
  const zohoClients = configured.filter(client => client.id.startsWith("zoho-"));
  assert.equal(zohoClients.length, 8, "Configured hosted runtime must expose eight synthetic Zoho clients");
  for (const client of zohoClients) {
    assert.equal(client.clientId, ZOHO_CLIENT_ID);
    assert.equal(Redacted.value(client.clientSecret), ZOHO_CLIENT_SECRET);
  }
  const hostedClientSummary = zohoClients.map(client => ({
    id: client.id,
    authorizationUrl: client.server.authorizationUrl,
    tokenUrl: client.server.tokenUrl,
    revocationUrl: client.server.revocationUrl,
    placement: client.placement,
    scopeCount: client.defaultScopes.length,
  }));
  const catalogApp = yield* Effect.promise(() => loadZohoCatalogSource({
    providerOrigin: provider.origin,
    upstream,
    hostedDefinitions: regionalDefinitions,
  }));
  const localOAuth = localZohoOAuthDefinition(regionalDefinitions, provider.origin);
  const sourceMetadata = {
    packageName: catalogApp.packageName,
    snapshot: catalogApp.snapshot,
    payload: catalogApp.payload,
    officialRegions: catalogApp.officialRegions,
    hostedRegionalClients: hostedClientSummary,
    sdkAdaptation: catalogApp.sdkAdaptation,
    loopbackOriginRewrites: catalogApp.loopbackOriginRewrites,
    localOAuthTestAdaptation: localOAuth.adaptation,
    providerOrigin: provider.origin,
  };
  yield* Effect.promise(() => writeJsonExclusive(join(directory, "source-metadata.json"), sourceMetadata));

  stage = "start local self-host runtime";
  const chromium = require("playwright").chromium;
  assert.equal(browserExecutable, chromium.executablePath(), "Prepared Chromium executable changed");
  yield* Effect.promise(() => access(browserExecutable));
  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ headless: true, executablePath: browserExecutable })),
    instance => Effect.promise(() => instance.close()),
  );
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* localNpmRegistry;
  const target = yield* startScenario(base.target, "Zoho CRM native OAuth and MCP isolation proof", undefined, {
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_OAUTH_CALLBACK_URL: callback,
    EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([localOAuth.definition]),
    EXECUTOR_OAUTH_ZOHO_LOCAL_PROOF_CLIENT_ID: ZOHO_CLIENT_ID,
    EXECUTOR_OAUTH_ZOHO_LOCAL_PROOF_CLIENT_SECRET: ZOHO_CLIENT_SECRET,
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
  });
  const services = yield* Layer.build(Actors.layer.pipe(
    Layer.provideMerge(SessionClients.layer),
    Layer.provideMerge(Layer.succeed(Target, target)),
  ));
  const proofActors = Context.get(services, Actors);
  const sessionsApi = Context.get(services, SessionClients);

  stage = "public Zoho OAuth, account health, and native MCP";
  const proof = yield* Effect.promise(() => proveZohoHosted({
    upstream,
    target,
    actors: proofActors,
    sessionsApi,
    browser,
    callback,
    provider,
    catalogApp,
    privateValues,
    setStage: value => { stage = value; },
    writeInvocation: async value => {
      const path = join(directory, "mcp-invocation.json");
      await writeJsonExclusive(path, value);
      return { path, sha256: digest(JSON.stringify(value, null, 2) + "\n") };
    },
  }));

  const providerRequests = provider.events();
  const report = {
    status: "passed",
    candidateCommit: proofPin.candidateCommit,
    baseCommit: proofPin.baseCommit,
    candidateTree: proofPin.sourcePin.candidateTree,
    runtimeCommit: proofPin.sourcePin.runtimeCommit,
    sourceSnapshotSha256: catalogApp.snapshot.sha256,
    deploymentPayloadSha256: catalogApp.payload.sha256,
    deploymentFiles: catalogApp.payload.files,
    sameOrganizationActors: proof.sameOrganizationActors,
    actorCount: proof.actorCount,
    checks: proof.checks,
    app: proof.app,
    oauth: proof.oauth,
    health: proof.health,
    actors: proof.actors,
    localOAuthTestAdaptation: localOAuth.adaptation,
    hostedRegionalClientCount: hostedClientSummary.length,
    invocationFiles: ["invocation.json", "mcp-invocation.json"],
    fixtureRequestFile: "provider-requests.json",
  };
  yield* Effect.promise(() => writeJsonExclusive(join(directory, "provider-requests.json"), providerRequests));
  yield* Effect.promise(() => writeJsonExclusive(join(directory, "outcome.json"), report));
  return report;
});

try {
  const report = await Effect.runPromise(program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ));
  console.log(JSON.stringify(report));
} catch (error) {
  if (provider) {
    try {
      await writeJsonExclusive(join(directory, "provider-requests.json"), provider.events());
    } catch {}
  }
  try {
    await writeJsonExclusive(join(directory, "failure.json"), boundedFailure(stage, error, privateValues));
  } catch {}
  console.error("Zoho native proof failed; see the bounded local failure envelope.");
  process.exitCode = 1;
}
