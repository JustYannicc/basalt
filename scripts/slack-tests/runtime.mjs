import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { access as accessFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Effect, Layer, Context, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { firstPartyOAuthClientDefinitions } from "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { startScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { Actors } from "../../.upstream/e2e/support/actors.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { localNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { appsVersion } from "../../.upstream/e2e/support/apps-release.ts";
import {
  assertSourceKeepsSlackTools,
  inspectPublishedAppsRelease,
  localSlackPackage,
  openapiSpecUrl,
  readSlackPackage,
  slackUserMethod,
} from "./catalog.mjs";
import { connectOwnerFromCatalog } from "./browser.mjs";
import { proveSlackMcp } from "./mcp.mjs";
import { startSlackMock } from "./mock.mjs";

const [root, upstream, directory, browserExecutable] = process.argv.slice(2);
const installDiagnostic = process.argv.includes("--install-diagnostic");
const callbackDiagnostic = process.argv.includes("--callback-diagnostic");
const require = createRequire(join(upstream, "package.json"));
const { chromium } = require("playwright");
process.chdir(upstream);

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks++; };
const privateAppend = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const appsReleaseReport = (manifest, selectedApps, frameworkManifest) => ({
  publishedAppsVersion: manifest.dependencies.apps,
  publishedAppsProtocol: selectedApps.frameworkProtocol,
  selectedAppsVersion: selectedApps.version,
  selectedAppsProtocol: selectedApps.frameworkProtocol,
  hostConfiguredAppsVersion: frameworkManifest.version,
  publishedAppsIntegrity: selectedApps.integrity,
});

async function vendorSpec(url, directory) {
  const address = new URL(url);
  assert.equal(address.origin, "https://raw.githubusercontent.com", "Only the package's public static Swagger source may be fetched");
  const response = await fetch(address, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Slack Swagger source returned HTTP ${response.status}`);
  const raw = await response.text();
  await writeFile(join(directory, "slack-openapi-vendor.json"), raw, { mode: 0o600 });
  const spec = JSON.parse(raw);
  assert.equal(spec.swagger, "2.0", "Slack source no longer points at its Swagger 2.0 document");
  assert.ok(spec.paths?.["/auth.test"], "Slack Swagger document lacks auth.test");
  assert.ok(spec.paths?.["/conversations.history"]?.get, "Slack Swagger document lacks conversations.history");
  assert.ok(spec.paths?.["/chat.postMessage"]?.post, "Slack Swagger document lacks chat.postMessage");
  return spec;
}

function oauthClientForLocalMock(client, origin, id) {
  const local = new URL(origin);
  const localUrl = (value) => {
    const url = new URL(value);
    return `${origin}${url.pathname}${url.search}${url.hash}`;
  };
  return {
    ...client,
    id,
    label: "Synthetic Slack local",
    server: {
      ...client.server,
      authorizationUrl: localUrl(client.server.authorizationUrl),
      tokenUrl: localUrl(client.server.tokenUrl),
    },
    placement: { ...client.placement, hosts: [local.host] },
  };
}

const program = Effect.gen(function* () {
  if (!root || !upstream || !directory || !browserExecutable)
    return yield* Effect.die(new Error("Slack proof inputs are required"));
  yield* Effect.promise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* Effect.promise(() => chmod(directory, 0o700));

  const source = yield* Effect.promise(() => readSlackPackage(root));
  assertSourceKeepsSlackTools(source);
  const appMethod = slackUserMethod(source);
  equal(appMethod.userScopes.length, 39, "The frozen Slack user_scope list must contain 39 scopes");
  const manifest = JSON.parse(source.files.find((file) => file.path === "package.json").content);
  const captured = JSON.parse(yield* Effect.promise(() => readFile(join(root, "src/catalog/slack.published.json"), "utf8")));
  equal(captured.package, source.package, "The carried package differs from the captured published package");
  const capturedManifest = JSON.parse(captured.files.find((file) => file.path === "package.json").content);
  equal(manifest.dependencies?.apps, capturedManifest.dependencies?.apps,
    "The maintained package changed the published apps dependency");
  const frameworkDirectory = join(upstream, ".local/basalt-framework");
  yield* Effect.promise(() => accessFile(join(frameworkDirectory, "framework.json")));
  const framework = JSON.parse(yield* Effect.promise(() => readFile(join(frameworkDirectory, "framework.json"), "utf8")));
  const frameworkManifest = JSON.parse(framework["package.json"]);
  equal(frameworkManifest.version, appsVersion, "The built compiler framework does not match the pinned apps release");

  const hostedClient = firstPartyOAuthClientDefinitions.find((client) => client.id === "slack-rest");
  check(hostedClient, "The pinned host has not added the slack-rest client yet");
  assert.deepEqual(hostedClient.defaultScopes, [], "slack-rest must ask for no normal OAuth scopes");
  equal(hostedClient.server.authorizationParams?.user_scope, appMethod.userScope,
    "Hosted slack-rest user_scope differs from the maintained app");
  equal(hostedClient.server.tokenResponse?.path, "authed_user", "Hosted slack-rest must read authed_user");
  equal(hostedClient.server.tokenResponse?.requiredOnExchange, true,
    "Hosted slack-rest must require the nested grant during authorization-code exchange");
  equal(hostedClient.tokenEndpointAuthMethod, "client_secret_post", "Slack REST client auth method changed");
  equal(hostedClient.server.grantedScopeSeparator, ",", "Slack's comma-separated user scopes must be parsed");
  equal(new URL(hostedClient.server.authorizationUrl).href, new URL(appMethod.authorizationUrl).href,
    "The Slack user app and hosted client authorization endpoints differ");
  equal(new URL(hostedClient.server.tokenUrl).href, new URL(appMethod.tokenUrl).href,
    "The Slack user app and hosted client token endpoints differ");
  equal(appMethod.userScope.split(",").length, appMethod.userScopes.length,
    "Slack user_scope did not serialize the maintained user scope list");

  const originalSpecUrl = openapiSpecUrl(source);
  const spec = yield* Effect.promise(() => vendorSpec(originalSpecUrl, directory));
  const authorizationPath = new URL(hostedClient.server.authorizationUrl).pathname;
  const tokenPath = new URL(hostedClient.server.tokenUrl).pathname;
  const mock = yield* Effect.acquireRelease(
    Effect.promise(() => startSlackMock({
      directory, source, vendorSpec: spec, userScope: appMethod.userScope, authorizationPath, tokenPath,
    })),
    (server) => Effect.promise(server.stop),
  );
  const localPackage = localSlackPackage(source, mock.origin, mock.openapiSpecUrl);
  yield* Effect.promise(() => writeFile(join(directory, "source-rewrites.json"),
    JSON.stringify(localPackage.changed, null, 2), { mode: 0o600 }));
  yield* Effect.promise(() => mock.loadFixture(localPackage.source));
  const localClientId = "slack-rest-local-proof";
  const localClient = oauthClientForLocalMock(hostedClient, mock.origin, localClientId);
  assert.deepEqual(localClient.server.tokenResponse, hostedClient.server.tokenResponse,
    "The local OAuth fixture must preserve the hosted token response contract");

  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* localNpmRegistry;
  const selectedApps = yield* Effect.promise(() => inspectPublishedAppsRelease(registry.url, manifest.dependencies.apps));
  equal(selectedApps.version, manifest.dependencies.apps,
    "The catalog app must select the apps release declared in its published package");
  assert.notEqual(selectedApps.version, frameworkManifest.version,
    "The fixture must exercise the published release instead of the host framework override");
  const target = yield* startScenario(base.target, "Slack user-token acceptance proof", undefined, {
    EXECUTOR_OAUTH_CALLBACK_URL: "http://127.0.0.1:0/api/oauth/callback",
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_APPS_FRAMEWORK: frameworkDirectory,
    EXECUTOR_APPS_VERSION: appsVersion,
    EXECUTOR_CATALOG_URL: `${mock.origin}/catalog/index.json`,
    EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([localClient]),
    EXECUTOR_OAUTH_SLACK_REST_LOCAL_PROOF_CLIENT_ID: "synthetic-slack-rest-client",
    EXECUTOR_OAUTH_SLACK_REST_LOCAL_PROOF_CLIENT_SECRET: "synthetic-slack-rest-secret",
  });

  const services = yield* Layer.build(
    Actors.layer.pipe(
      Layer.provideMerge(SessionClients.layer),
      Layer.provideMerge(Layer.succeed(Target, target)),
    ),
  );
  const actors = Context.get(services, Actors);
  const sessionsApi = Context.get(services, SessionClients);
  const request = (actor, method, path, data) => sessionsApi.request(actor, method, path, data);
  const checked = (response, status, operation) => {
    if (response.status !== status)
      privateAppend(join(directory, "responses.jsonl"), { operation, status: response.status, body: response.body });
    equal(response.status, status, operation);
    return response.body;
  };
  const prefix = `/api/organizations/${actors.organization.id}`;

  const catalog = checked(yield* request(actors.owner, "GET", "/api/catalog"), 200, "Read the local app catalog");
  const entry = catalog.find((item) => item.id === "slack");
  check(entry, "The local Slack catalog entry is missing");
  equal(entry.package, source.package, "The catalog did not serve the maintained Slack package");
  equal(entry.auth.find((item) => item.kind === "oauth2")?.method, "user", "The catalog did not list user OAuth first");
  check(entry.connectionNotices?.some((notice) => notice.providerName === "Slack"), "The local Slack notice is missing");

  const ownerCookies = Redacted.value(yield* actors.owner.cookies);
  const ui = yield* Effect.promise(() => connectOwnerFromCatalog({
    target, actors, ownerCookies, mock, directory, chromium, browserExecutable, check, equal,
    diagnosticOnly: installDiagnostic,
    callbackDiagnostic,
  }));
  if (installDiagnostic) {
    const report = {
      installDiagnostic: true,
      checks,
      outcome: ui.installed ? "installed" : "install_failed",
      installResponse: ui.installResponse,
      appPackage: appsReleaseReport(manifest, selectedApps, frameworkManifest),
      screenshot: ui.installed ? "slack-connect-notice.png" : "slack-connect-failure.png",
    };
    yield* Effect.promise(() => writeFile(join(directory, "install-diagnostic.json"),
      JSON.stringify(report, null, 2), { mode: 0o600 }));
    console.log(JSON.stringify(report));
    return report;
  }
  const ownerAccount = ui.accountId;
  check(typeof ownerAccount === "string", "The UI-started OAuth connection did not create an account");

  if (callbackDiagnostic) {
    const report = {
      callbackDiagnostic: true,
      checks,
      callback: {
        target: ui.redirectTarget,
        request: ui.callbackRequest,
        response: ui.callbackResponse,
        dashboardResponse: ui.dashboardResponse,
        completionResponse: ui.completionResponse,
        connectedText: ui.connectedText,
      },
      appPackage: appsReleaseReport(manifest, selectedApps, frameworkManifest),
    };
    yield* Effect.promise(() => writeFile(join(directory, "callback-diagnostic.json"),
      JSON.stringify(report, null, 2), { mode: 0o600 }));
    console.log(JSON.stringify(report));
    return report;
  }

  const inventory = checked(yield* request(actors.owner, "GET", `${prefix}/inventory`), 200, "Read the installed Slack app");
  const app = inventory.apps.find((item) => item.copiedFrom?.name === source.package);
  check(app, "The connect row did not install the maintained Slack package");
  equal(Object.entries(app.requirements.accounts.slack.definition.auth)
    .find(([, auth]) => auth.type === "oauth2")?.[0], "user",
  "The public app requirement did not put user OAuth first");
  equal(app.requirements.accounts.slack.scope, "user", "The Slack requirement must use the caller's personal account");
  const access = checked(yield* request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`), 200, "Read Slack app access");
  checked(yield* request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
    revision: access.revision, audience: { kind: "everyone" },
  }), 200, "Share the Slack app with the organization");

  const memberConnection = checked(yield* request(actors.member, "POST",
    `${prefix}/apps/${app.id}/accounts/user/slack/connections`, { destination: { kind: "personal" } }),
  200, "Create the member's personal Slack connection");
  const memberStarted = checked(yield* request(actors.member, "POST",
    `${prefix}/connections/${memberConnection.id}/oauth/start`, { method: "user", label: "Synthetic member Slack" }),
  200, "Start Slack user OAuth for the second person");
  const memberCallback = yield* Effect.promise(() => mock.approveWithoutBrowser(memberStarted.authorizationUrl, "member"));
  const memberCompleted = checked(yield* request(actors.member, "POST",
    `${prefix}/connections/${memberConnection.id}/oauth/complete`, { callbackUrl: memberCallback }),
  200, "Complete the member's Slack user OAuth connection");
  const memberAccount = memberCompleted.id;
  check(typeof memberAccount === "string" && memberAccount !== ownerAccount,
    "Slack users did not get distinct personal accounts");

  for (const [actor, account] of [[actors.owner, ownerAccount], [actors.member, memberAccount]]) {
    const result = checked(yield* request(actor, "POST", `${prefix}/accounts/${account}/health`), 200,
      "Run Slack auth.test health check");
    const appChecks = result.apps?.map((item) => item.check?.status) ?? [];
    check(appChecks.includes("healthy"), "Slack health check did not pass through auth.test");
  }

  const proof = yield* proveSlackMcp({
    root, upstream, directory, target, actors, request, checked, prefix, app,
    ownerAccount, memberAccount, mock, check, equal,
  });
  const report = {
    checks,
    catalogOneClickMethod: "user",
    firstPartyClient: "slack-rest",
    hostedOAuth: {
      scopes: [],
      userScopeCount: appMethod.userScopes.length,
      nestedGrant: "authed_user",
      requiredOnExchange: true,
    },
    appPackage: appsReleaseReport(manifest, selectedApps, frameworkManifest),
    callerTokensUsedForApi: true,
    approvalAsNativeMcpCaller: true,
    sameOrganizationIsolation: true,
    ...proof,
  };
  yield* Effect.promise(() => writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 }));
  console.log(JSON.stringify(report));
  return report;
});

await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
try {
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))));
} catch (error) {
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Slack acceptance proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
