import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";
import { Context, Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { startScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { Actors } from "../../.upstream/e2e/support/actors.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { firstPartyOAuthClientDefinitions } from "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts";
import { startProviderFixture } from "./provider-fixture.mjs";
import { brand } from "../../brand.ts";
import { deploymentPayload, digest, mcpExecutionEvidence, pinProofSource, redactDiagnostic, unavailableAppsEvidence } from "./provider-evidence.mjs";
import {
  adaptProviderAppFiles,
  matchFirstPartyOAuth,
  prepareLocalMockSource,
  readProviderSnapshot,
} from "./provider-source.mjs";

const scriptRoot = fileURLToPath(new URL("../..", import.meta.url));
const root = resolve(process.argv[2] ?? scriptRoot);
assert.equal(root, resolve(scriptRoot), "The root must be this runner's checkout");
const upstream = join(root, ".upstream");
const snapshotsDirectory = resolve(
  process.argv[3] ?? join(root, ".generated/connector-snapshots"),
);
const evidenceRoot = resolve(process.argv[4] ?? join(root, ".generated/connectors-proof"));
const candidateCommit = process.argv[5];
const baseCommit = process.argv[6];
const sourcePin = pinProofSource(root, candidateCommit, baseCommit);
const runId = `providers-${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(3).toString("hex")}`;
const evidenceDirectory = join(evidenceRoot, runId);
const state = { stage: "initialization", checks: [], oauth: [], snapshots: {}, deployments: [], runtime: [], sourceChanges: [], diagnostics: [], searchResults: [], mockRequests: {}, mockSpecRequests: {} };
const privateValues = [];
const mockFixtures = {};
const captureMockRequests = () => {
  for (const [provider, fixture] of Object.entries(mockFixtures)) {
    state.mockRequests[provider] = fixture.requests.filter(request => request.kind === "api");
    state.mockSpecRequests[provider] = fixture.requests.filter(request => request.kind === "spec")
      .map(({ method, path }) => ({ method, path }));
  }
};
const stamp = (stage) => { state.stage = stage; };
const record = (name) => { state.checks.push(name); };

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await chmod(evidenceDirectory, 0o700);
const evidenceFile = join(evidenceDirectory, "providers-proof.json");
await writeFile(join(evidenceDirectory, "invocation.json"), `${JSON.stringify({
  runId, sourcePin, startedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600, flag: "wx" });

const sourceDigest = files => digest(JSON.stringify(files.map(({ path, content }) => ({ path, content }))));
const byPath = (files, path) => {
  const file = files.find((item) => item.path === path);
  assert.ok(file, `Snapshot is missing ${path}`);
  return file.content;
};

const checked = (response, status, operation) => {
  if (response.status !== status) {
    const tag = response.body !== null && typeof response.body === "object" &&
      typeof response.body._tag === "string" ? response.body._tag : undefined;
    const diagnostic = { status: response.status, ...(tag === undefined ? {} : { _tag: tag }) };
    state.diagnostics.push({ operation, ...diagnostic });
    assert.equal(response.status, status, `${operation} returned ${JSON.stringify(diagnostic)}`);
  }
  return response.body;
};
const resultText = (result) => JSON.stringify(result.structuredContent ?? result.content);

async function mcpClient(Client, StreamableHTTPClientTransport, origin, token) {
  const client = new Client({ name: "connector-provider-proof", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

const appsVersion = JSON.parse(await readFile(join(upstream, "packages/apps/package.json"), "utf8")).version;
const require = createRequire(join(upstream, "package.json"));
const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);
process.chdir(upstream);

const program = Effect.gen(function* () {
  stamp("read-official-snapshots-and-host-definitions");
  const officialFiles = {};
  const definitionMap = {};
  const exactSourceEvidence = state.snapshots;
  for (const providerId of ["gitlab", "miro"]) {
    const input = yield* Effect.promise(() => readProviderSnapshot(providerId, snapshotsDirectory));
    definitionMap[providerId] = matchFirstPartyOAuth(
      providerId,
      input.snapshot.files,
      upstream,
      firstPartyOAuthClientDefinitions,
    );
    record(`official ${providerId} OAuth endpoints, scopes, auth method, and host match the host first-party definition`);
    const adapted = adaptProviderAppFiles(input.snapshot.files, appsVersion, providerId);
    exactSourceEvidence[providerId] = {
      snapshotPath: input.path,
      snapshotSha256: digest(input.bytes),
      officialFilesSha256: sourceDigest(input.snapshot.files),
      appCodeSha256: {
        "index.ts": digest(byPath(input.snapshot.files, "index.ts")),
        "openapi.ts": digest(byPath(input.snapshot.files, "openapi.ts")),
      },
      packageVersionAdaptation: adapted.packageVersion,
    };
    officialFiles[providerId] = adapted.files;
  }
  record("both saved official package snapshots parsed and source digests captured");

  const fixtures = yield* Effect.acquireRelease(
    Effect.promise(async () => Promise.all(["gitlab", "miro"].map((kind) => startProviderFixture(kind)))),
    (servers) => Effect.promise(async () => Promise.all(servers.map((server) => server.stop()))),
  );
  const fixtureMap = Object.fromEntries(fixtures.map((fixture) => [fixture.kind, fixture]));
  Object.assign(mockFixtures, fixtureMap);
  stamp("start-isolated-self-host-with-first-party-settings-and-local-fixtures");
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const runtimeTarget = yield* startScenario(base.target, "GitLab and Miro local mock connector proof", undefined, {
    EXECUTOR_PRODUCT_NAME: brand.name,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_OAUTH_GITLAB_CLIENT_ID: "synthetic-gitlab-first-party-client",
    EXECUTOR_OAUTH_GITLAB_CLIENT_SECRET: "synthetic-gitlab-first-party-secret",
    EXECUTOR_OAUTH_MIRO_CLIENT_ID: "synthetic-miro-first-party-client",
    EXECUTOR_OAUTH_MIRO_CLIENT_SECRET: "synthetic-miro-first-party-secret",
  });
  for (const value of [
    "synthetic-gitlab-first-party-client", "synthetic-gitlab-first-party-secret",
    "synthetic-miro-first-party-client", "synthetic-miro-first-party-secret",
    ...Object.values(fixtureMap).flatMap((fixture) => Object.values(fixture.definition.tokens)),
  ]) privateValues.push(value);
  const services = yield* Layer.build(Actors.layer.pipe(
    Layer.provideMerge(SessionClients.layer),
    Layer.provideMerge(Layer.succeed(Target, runtimeTarget)),
  ));
  const actors = Context.get(services, Actors);
  const sessionsApi = Context.get(services, SessionClients);
  const request = (actor, method, path, data) => sessionsApi.request(actor, method, path, data);
  const orgPath = `/api/organizations/${actors.organization.id}`;
  const packageVersion = appsVersion;

  stamp("deploy-unmodified-official-source-and-check-first-party-oauth-setup");
  const productionSetup = {};
  for (const providerId of ["gitlab", "miro"]) {
    const deployment = { provider: providerId, kind: "official-source", status: "attempted", payload: deploymentPayload(officialFiles[providerId]) };
    state.deployments.push(deployment);
    const app = checked(yield* request(actors.owner, "POST", `${orgPath}/apps/deploy`, {
      name: `${providerId} official source OAuth definition proof`,
      files: officialFiles[providerId],
    }), 200, `${providerId} official source deploy`);
    assert.ok(app.id && app.slug, `${providerId} official source app did not build`);
    Object.assign(deployment, { appId: app.id, slug: app.slug, status: "deployed" });
    const providerRef = app.requirements?.accounts?.[providerId]?.provider;
    assert.equal(typeof providerRef, "string", `${providerId} deployed app did not expose its normalized provider reference`);
    const setup = checked(yield* request(actors.owner, "GET", `${orgPath}/providers/${encodeURIComponent(providerRef)}/oauth/oauth/setup`), 200,
      `${providerId} host OAuth setup`);
    const definition = definitionMap[providerId];
    productionSetup[providerId] = {
      appId: app.id,
      appSlug: app.slug,
      providerRef,
      mode: setup.mode,
      label: setup.firstParty?.label,
      scopes: setup.scopes,
      tokenEndpointAuthMethod: setup.tokenEndpointAuthMethod,
      issuer: setup.issuer,
    };
    state.oauth = productionSetup;
    assert.equal(setup.mode, "automatic", `${providerId} must match an automatic first-party client`);
    assert.equal(setup.firstParty?.label, definition.label.replace(/^Executor\b/, brand.name), `${providerId} first-party label`);
    assert.deepEqual(setup.scopes, definition.defaultScopes, `${providerId} first-party scopes`);
    assert.equal(setup.tokenEndpointAuthMethod, definition.tokenEndpointAuthMethod, `${providerId} client auth method`);
    assert.equal(setup.issuer, definition.server.tokenUrl, `${providerId} OAuth issuer`);
    record(`${providerId} unmodified official source compiled and host selected its configured first-party OAuth client`);
  }

  stamp("deploy-local-origin-substitution-variants");
  const mockApps = {};
  const beforeChanges = state.sourceChanges.length;
  for (const providerId of ["gitlab", "miro"]) {
    const localSource = prepareLocalMockSource(
      officialFiles[providerId],
      providerId,
      fixtureMap[providerId],
      packageVersion,
    );
    state.sourceChanges.push(...localSource.substitutions);
    const files = localSource.files;
    const deployment = { provider: providerId, kind: "local-origin-substitution", status: "attempted", payload: deploymentPayload(files) };
    state.deployments.push(deployment);
    const app = checked(yield* request(actors.owner, "POST", `${orgPath}/apps/deploy`, {
      name: `${providerId} local mock runtime proof`,
      files,
    }), 200, `${providerId} local mock source deploy`);
    assert.ok(app.id && app.slug, `${providerId} local mock app did not build`);
    Object.assign(deployment, { appId: app.id, slug: app.slug, status: "deployed" });
    const appPath = `${orgPath}/apps/${app.id}`;
    const access = checked(yield* request(actors.owner, "GET", `${appPath}/access`), 200, `${providerId} read app audience`);
    checked(yield* request(actors.owner, "PATCH", `${appPath}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    }), 200, `${providerId} share app in isolated organization`);
    mockApps[providerId] = { ...app, path: appPath, files };
    deployment.audience = "everyone";
    record(`${providerId} origin-substituted official source compiled and was shared in the isolated organization`);
  }

  stamp("connect-two-personal-accounts-and-call-native-mcp-tools");
  const actorsByPrincipal = [actors.member, actors.admin];
  const principalNames = ["first", "second"];
  for (const providerId of ["gitlab", "miro"]) {
    const fixture = fixtureMap[providerId];
    const app = mockApps[providerId];
    const accounts = [];
    const patTokens = [];
    for (const [index, actor] of actorsByPrincipal.entries()) {
      const principal = principalNames[index];
      const personal = checked(yield* request(actor, "POST", `${app.path}/accounts/user/${providerId}/connections`, {
        destination: { kind: "personal" },
      }), 200, `${providerId} ${principal} personal connection`);
      const saved = checked(yield* request(actor, "POST", `${orgPath}/connections/${personal.id}/submit`, {
        method: "token",
        label: `Synthetic ${providerId} ${principal}`,
        fields: { token: fixture.definition.tokens[principal] },
      }), 200, `${providerId} ${principal} save local mock account`);
      accounts.push(saved.id);
      const issued = checked(yield* request(actor, "POST", "/api/auth/api-key/create", {
        name: `Synthetic ${providerId} native MCP proof`,
        metadata: { organization: actors.organization.id },
      }), 200, `${providerId} ${principal} issue organization-pinned MCP token`);
      patTokens.push(issued.key);
      privateValues.push(issued.key);
    }

    for (const index of [0, 1]) {
      const actor = actorsByPrincipal[index];
      const principal = principalNames[index];
      const peerId = accounts[1 - index];
      const peerRead = yield* request(actor, "GET", `${orgPath}/accounts/${peerId}`);
      assert.ok(peerRead.status === 403 || peerRead.status === 404, `${providerId} ${principal} must not read peer account`);
      const peerLink = yield* request(actor, "PUT", `${app.path}/accounts/user/${providerId}/${peerId}`);
      assert.ok(peerLink.status === 403 || peerLink.status === 404, `${providerId} ${principal} must not link peer account`);
      record(`${providerId} ${principal} peer account detail and link requests were denied`);

      const health = checked(yield* request(actor, "POST", `${orgPath}/accounts/${accounts[index]}/health`),
        200, `${providerId} ${principal} check own account health`);
      assert.equal(health.apps.find(item => item.app === app.id)?.check?.status, "healthy",
        `${providerId} ${principal} official health check must pass`);
      record(`${providerId} ${principal} official health check passed through the local mock`);

      const client = yield* Effect.acquireRelease(
        Effect.promise(() => mcpClient(Client, StreamableHTTPClientTransport, runtimeTarget.metadata.origin, patTokens[index])),
        (opened) => Effect.promise(() => opened.close()),
      );
      const search = yield* Effect.promise(() => client.callTool({ name: "search", arguments: { query: app.slug, namespace: app.slug } }));
      const searchItems = search.structuredContent?.items;
      state.searchResults.push({
        provider: providerId,
        principal,
        namespace: app.slug,
        unavailableApps: unavailableAppsEvidence(search, privateValues),
        paths: Array.isArray(searchItems)
          ? searchItems.flatMap((item) => typeof item?.path === "string" ? [item.path] : [])
          : [],
      });
      captureMockRequests();
      assert.ok(!search.isError, `${providerId} ${principal} native MCP search failed`);
      const tool = searchItems?.find((item) => item.path.endsWith(`.${fixture.definition.operationName}`));
      assert.ok(tool, `${providerId} ${principal} native search did not return ${fixture.definition.operationName}`);
      const described = yield* Effect.promise(() => client.callTool({ name: "describe", arguments: { paths: [tool.path] } }));
      assert.ok(!described.isError, `${providerId} ${principal} native MCP describe failed`);
      const called = yield* Effect.promise(() => client.callTool({ name: "call", arguments: {
        calls: { path: tool.path, input: { accountId: accounts[index], input: {} } },
      } }));
      const output = resultText(called);
      const ownMarker = `${providerId === "gitlab" ? "synthetic_gitlab" : "synthetic_miro"}_${principal}_${providerId === "gitlab" ? "project" : "board"}`;
      const peer = principalNames[1 - index];
      const peerMarker = `${providerId === "gitlab" ? "synthetic_gitlab" : "synthetic_miro"}_${peer}_${providerId === "gitlab" ? "project" : "board"}`;
      const callEvidence = {
        provider: providerId,
        principal,
        tool: tool.path,
        outputMarker: ownMarker,
        isError: Boolean(called.isError),
        mcpExecution: mcpExecutionEvidence(called, privateValues),
        ownMarkerPresent: output.includes(ownMarker),
        peerMarkerPresent: output.includes(peerMarker),
        outputLength: output.length,
        contentTypes: (called.content ?? []).flatMap((item) => typeof item?.type === "string" ? [item.type] : []),
        peerAccountReadStatus: peerRead.status,
        peerAccountLinkStatus: peerLink.status,
      };
      state.runtime.push(callEvidence);
      captureMockRequests();
      assert.ok(callEvidence.mcpExecution.execution?.ok &&
        callEvidence.mcpExecution.execution.callOutcomes.length === 1 &&
        callEvidence.mcpExecution.execution.callOutcomes[0].ok,
      `${providerId} ${principal} native call must complete successfully`);
      assert.ok(!called.isError && callEvidence.ownMarkerPresent && !callEvidence.peerMarkerPresent,
        `${providerId} ${principal} native call did not return only the caller's mock result ${JSON.stringify(callEvidence)}`);
      record(`${providerId} ${principal} native MCP tool returned only its personal mock account data`);

      const beforePeerCall = fixture.requests.filter(request => request.kind === "api").length;
      const peerCall = yield* Effect.promise(() => client.callTool({ name: "call", arguments: {
        calls: { path: tool.path, input: { accountId: peerId, input: {} } },
      } }));
      const peerExecution = mcpExecutionEvidence(peerCall, privateValues);
      const denied = peerExecution.execution?.callOutcomes;
      assert.ok(denied?.length === 1 && denied[0].ok === false &&
        denied[0].error?.message?.startsWith("InputInvalid (HTTP 422)"),
      `${providerId} ${principal} peer account must be excluded from the native tool's input`);
      assert.equal(fixture.requests.filter(request => request.kind === "api").length, beforePeerCall,
        `${providerId} ${principal} peer call must not contact the provider`);
      callEvidence.peerMcpExecution = peerExecution;
      record(`${providerId} ${principal} native MCP denied the peer account before a provider request`);
    }
  }

  stamp("verify-local-mock-boundary-and-write-evidence");
  const mockEvidence = {};
  for (const providerId of ["gitlab", "miro"]) {
    const fixture = fixtureMap[providerId];
    const apiCalls = fixture.requests.filter((request) => request.kind === "api");
    const firstHealth = apiCalls.some((request) => request.path === fixture.definition.healthPath && request.principal === "first");
    const secondHealth = apiCalls.some((request) => request.path === fixture.definition.healthPath && request.principal === "second");
    const firstTool = apiCalls.some((request) => request.path === fixture.definition.toolPath && request.principal === "first");
    const secondTool = apiCalls.some((request) => request.path === fixture.definition.toolPath && request.principal === "second");
    assert.ok(firstHealth && secondHealth && firstTool && secondTool, `${providerId} both health and tool requests must reach local mock`);
    assert.ok(apiCalls.every((request) => request.principal === "first" || request.principal === "second"),
      `${providerId} local mock received an unknown or missing credential`);
    assert.ok(apiCalls.every((request) => request.authHeader === fixture.definition.tokenHeader),
      `${providerId} local mock saw an unexpected credential header`);
    mockEvidence[providerId] = {
      origin: fixture.origin,
      apiRequests: apiCalls,
      specificationRequests: fixture.requests
        .filter((request) => request.kind === "spec")
        .map(({ method, path }) => ({ method, path })),
      bothPrincipalsReachedHealthAndTool: true,
      forwardedRequests: 0,
    };
    record(`${providerId} health and tool requests used only the local mock and correct account header`);
  }
  assert.ok(state.sourceChanges.length > beforeChanges, "Expected explicit origin substitutions for both provider sources");

  return {
    outcome: "passed",
    runId,
    scope: "bounded local mock proof for the saved GitLab and Miro official app snapshots",
    runtime: {
      kind: "prepared public self-host runtime with same-organization member and admin actors",
      nativeMcp: true,
      sharedAppAudience: "everyone within the isolated organization",
      liveProviderRequests: 0,
      browserVisitedProvider: false,
    },
    appsVersion,
    snapshots: exactSourceEvidence,
    configuredFirstPartyOAuth: productionSetup,
    sourcePin,
    deployments: state.deployments,
    runtimeCalls: state.runtime,
    nativeSearchResults: state.searchResults,
    localMockSpecRequests: state.mockSpecRequests,
    localMocks: mockEvidence,
    substitutions: state.sourceChanges,
    passedChecks: state.checks,
    limits: [
      "OAuth setup matched the current host first-party definitions, but no provider browser sign-in, code exchange, refresh, or live acceptance was attempted.",
      "GitLab OAuth refresh redirect_uri behavior was not exercised; the separate upstream regression finding remains outside this local mock proof.",
      "The deployed local-mock app source preserves each official snapshot's index.ts and openapi.ts logic, while its provider hosts, request origins, OpenAPI source URL, and apps package version are adapted for the local runtime.",
      "Each local mock served a minimal OpenAPI document for one real GitLab or Miro API path; this proves the official app router, credential placement, runtime calls, and personal-account isolation for those paths, not acceptance against the vendor's full live specification.",
    ],
  };
});

let result;
try {
  result = await Effect.runPromise(program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ));
  await writeFile(evidenceFile, `${JSON.stringify({ ...result, evidenceDirectory }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outcome: result.outcome, evidenceFile, checks: result.passedChecks.length }));
} catch (error) {
  captureMockRequests();
  const message = redactDiagnostic(error?.message ?? error, privateValues);
  const failure = {
    outcome: "failed",
    runId,
    sourcePin,
    stage: state.stage,
    message,
    checksCompleted: state.checks,
    snapshots: state.snapshots,
    deployments: state.deployments,
    oauthSetupCompleted: state.oauth,
    runtimeCallsCompleted: state.runtime,
    nativeSearchResults: state.searchResults,
    localMockRequests: state.mockRequests,
    localMockSpecRequests: state.mockSpecRequests,
    sanitizedDiagnostics: state.diagnostics,
    evidenceDirectory,
  };
  await writeFile(evidenceFile, `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
  console.error(JSON.stringify({ outcome: "failed", stage: state.stage, evidenceFile, message }));
  process.exitCode = 1;
}
