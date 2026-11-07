import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Cause, Context, Effect, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../.upstream/e2e/support/managed-server.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../.upstream/e2e/support/npm-registry.ts";
import { Browser, BrowserDriver } from "../.upstream/e2e/support/browser.ts";
import { scenarioEvidence, Telemetry } from "../.upstream/e2e/support/evidence.ts";
import { RecordingFocus } from "../.upstream/e2e/support/recording-focus.ts";
import { planetScaleOAuthClient } from "../.upstream/apps/hosted/server/src/implementation/planetscale-oauth.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { startPlanetScaleCatalog } from "./planetscale-signin/catalog.mjs";
import { hostedClient, startPlanetScale } from "./planetscale-signin/service.mjs";

import { hostedScopes, sorted } from "./planetscale-signin/expectations.mjs";
import { verifyPlanetScaleConnections } from "./planetscale-signin/journey.mjs";
import { appsVersion } from "../.upstream/e2e/support/apps-release.ts";
import { createPlanetScaleRetainedFixture } from "./planetscale-signin/retained-fixture.mjs";
import { verifyPlanetScaleRetainedAccounts } from "./planetscale-signin/retained-accounts.mjs";
import {
  legacyPlanetScaleScopes,
  replaceHostedClient,
  upgradeAndExpireGrant,
} from "./planetscale-signin/retained-runtime.mjs";
const mode = process.argv[3] ?? "hosted";
assert.ok(
  mode === "retained" ||
    mode === "retained-unknown" ||
    mode === "hosted" ||
    mode === "dcr" ||
    mode === "unknown" ||
    mode === "refused" ||
    mode === "unreported" ||
    mode === "rfc",
  "Mode is hosted, dcr, unknown, refused, unreported or rfc",
);
const retained = mode.startsWith("retained");
const oldScopes = retained
  ? await legacyPlanetScaleScopes(resolve(import.meta.dirname, ".."))
  : undefined;
const usesDcr = mode === "dcr" || mode === "unknown";
const hasHostedClient = !usesDcr;
const omitsGrantedScope =
  mode === "unknown" || mode === "unreported" || mode === "rfc" || mode === "retained-unknown";
const refusedScope = "organization:write_branches";
const widths = ["unknown", "rfc"].includes(mode) ? [1280] : [1280, 390];
const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/planetscale-sign-in", randomBytes(6).toString("hex")),
  mode,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const metadata = JSON.parse(
  await readFile(join(import.meta.dirname, "planetscale-signin/metadata.json"), "utf8"),
);
process.chdir(upstream);
const outcomes = [];
const program = Effect.gen(function* () {
  const start = (acquire) =>
    Effect.acquireRelease(Effect.promise(acquire), (fixture) => Effect.promise(fixture.stop));
  const service = yield* start(() =>
    startPlanetScale({
      dcr: usesDcr,
      advertised:
        mode === "hosted"
          ? ["read_user"]
          : hasHostedClient
            ? hostedScopes
            : metadata.scopes_supported,
      omitGrantedScope: omitsGrantedScope,
      ...(retained
        ? { refreshScopes: oldScopes.filter((scope) => scope !== "organization:write_comments") }
        : {}),
      ...(mode === "refused" ? { refuseScope: refusedScope } : {}),
    }),
  );
  const catalog = yield* start(() => startPlanetScaleCatalog(service.origin));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      writeFile(
        join(directory, "service-observations.json"),
        JSON.stringify({ calls: service.calls, failures: service.failures }, null, 2),
      ),
    ),
  );
  assert.deepEqual(sorted(planetScaleOAuthClient.defaultScopes), sorted(hostedScopes));
  assert.deepEqual(
    sorted(planetScaleOAuthClient.allowedScopes),
    sorted([
      ...hostedScopes,
      "organization:read_comments",
      "organization:write_comments",
      "organization:read_members",
    ]),
  );
  assert.equal(planetScaleOAuthClient.requireScopeConfirmation, true);
  // The reviewed client, moved to the loopback service as the Slack proof moves its client.
  const fixtureClient = {
    ...planetScaleOAuthClient,
    id: "planetscale-e2e",
    label: "Synthetic PlanetScale",
    requireScopeConfirmation: mode !== "rfc",
    server: {
      ...planetScaleOAuthClient.server,
      issuer: service.origin,
      authorizationUrl: `${service.origin}/oauth/authorize`,
      tokenUrl: `${service.origin}/oauth/token`,
    },
    placement: { hosts: [new URL(service.origin).host] },
  };
  const oldClient = retained
    ? {
        ...fixtureClient,
        defaultScopes: oldScopes,
        allowedScopes: oldScopes,
        requireScopeConfirmation: false,
      }
    : undefined;
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, `PlanetScale ${mode} sign-in`);
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target: {
        ...prepared,
        metadata: { ...prepared.metadata, origin: "https://app.fixture.localhost" },
      },
      authSecret,
      directory,
      organization: `planetscale-${mode}`,
      namePrefix: "planetscale",
    }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_CATALOG_URL: `${catalog.origin}/catalog/index.json`,
    E2E_HTTPS_APP_ORIGINS: "true",
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([catalog.origin, service.origin]),
    ...(hasHostedClient
      ? {
          EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([oldClient ?? fixtureClient]),
          EXECUTOR_OAUTH_PLANETSCALE_E2E_CLIENT_ID: hostedClient.id,
          EXECUTOR_OAUTH_PLANETSCALE_E2E_CLIENT_SECRET: hostedClient.secret,
        }
      : {}),
  });
  const target = Target.of({
    ...prepared,
    evidenceDirectory: directory,
    controlOrigin: server.controlOrigin,
    ...(server.tlsCertificate === undefined ? {} : { tlsCertificate: server.tlsCertificate }),
    metadata: { ...prepared.metadata, origin: server.origin },
  });
  const services = yield* Layer.build(
    SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
  );
  const client = Context.get(services, SessionClients);
  const session = yield* client.session(Redacted.make(actors.owner.cookies));
  const prefix = `/api/organizations/${actors.organization.id}`;
  const request = (method, path, data) =>
    client.request(session, method, path, data).pipe(
      Effect.map((response) => {
        assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
        return response.body;
      }),
    );
  const installed = yield* request("POST", `${prefix}/apps/install`, {
    entry: "planetscale",
    name: "PlanetScale",
  });
  const app = installed;
  assert.deepEqual(Object.keys(app.requirements.accounts), ["planetscaleSignIn", "planetscale"]);
  const path = `${prefix}/apps/${app.id}`;
  const call = (tool, accountId, input = {}) =>
    client.request(session, "POST", `${path}/tools/call`, { tool, input: { accountId, input } });
  const getTool = (tool) =>
    client.request(session, "GET", `${path}/tools/${encodeURIComponent(tool)}`);
  const listed = () =>
    request("GET", `${path}/tools/index`).pipe(
      Effect.map((index) => sorted(index.items.map((tool) => tool.name))),
    );
  const links = () => request("GET", `${path}/accounts/user`);
  const added = (before, after) =>
    after.filter((link) => !before.some((old) => old.account.id === link.account.id));
  const apiCalls = (operation) =>
    service.calls.filter((entry) => entry.phase === "api" && entry.operation === operation);
  for (const width of widths) {
    const result = yield* Effect.exit(
      (retained
        ? replaceHostedClient(oldClient).pipe(
            Effect.andThen(
              verifyPlanetScaleRetainedAccounts({
                width,
                request: (method, path, data) => client.request(session, method, path, data),
                prefix,
                app,
                session,
                service,
                fixture: createPlanetScaleRetainedFixture({
                  root,
                  serviceOrigin: service.origin,
                  appsVersion,
                }),
                upgradeHost: upgradeAndExpireGrant(fixtureClient),
                unknown: mode === "retained-unknown",
              }),
            ),
          )
        : verifyPlanetScaleConnections({
            width,
            directory,
            mode,
            session,
            actors,
            app,
            links,
            request,
            path,
            prefix,
            omitsGrantedScope,
            refusedScope,
            added,
            listed,
            call,
            apiCalls,
            client,
            getTool,
            service,
          })
      ).pipe(
        Effect.timeout("120 seconds"),
        Effect.scoped,
        Effect.provide(Browser.layer),
        Effect.provide(
          scenarioEvidence({
            file: "e2e/planetscale-sign-in.mjs",
            name: `PlanetScale ${mode} ${width}`,
          }),
        ),
        Effect.provide(Telemetry.layer),
        Effect.provide(RecordingFocus.layer),
        Effect.provide(BrowserDriver.layer),
        Effect.provideService(Target, target),
      ),
    );
    outcomes.push({
      width,
      status: result._tag,
      ...(result._tag === "Success" && retained ? { retainedEvidence: result.value } : {}),
      ...(result._tag === "Failure" ? { error: Cause.pretty(result.cause) } : {}),
      linkedAccounts: (yield* links()).map(({ requirement, account }) => ({
        requirement,
        id: account.id,
        method: account.method,
      })),
    });
  }
  assert.ok(
    outcomes.every((result) => result.status === "Success"),
    JSON.stringify(outcomes),
  );
  const phase = (name) => service.calls.filter((entry) => entry.phase === name);
  if (hasHostedClient) {
    assert.equal(phase("register").length, 0, "A configured hosted client never registers");
    assert.ok(phase("authorize").length > 0);
    for (const [index, authorize] of phase("authorize").entries()) {
      assert.equal(authorize.client, hostedClient.id);
      assert.deepEqual(
        sorted(authorize.scope.split(" ")),
        sorted(
          retained && (mode === "retained-unknown" || index % 2 === 0) ? oldScopes : hostedScopes,
        ),
        "Exactly the configured scopes",
      );
    }
    assert.ok(phase("token").every((entry) => entry.client === hostedClient.id && entry.basic));
  } else {
    assert.ok(phase("register").length > 0, "Without a hosted client, sign-in registers one");
    // The method declares no scopes, so the strict registration check compares an empty request.
    assert.ok(phase("register").every((entry) => entry.scope === null || entry.scope === ""));
    assert.ok(phase("authorize").every((entry) => entry.scope === ""));
    assert.ok(phase("token").every((entry) => entry.basic));
  }
  assert.equal(
    service.calls.some((entry) => entry.phase === "api" && entry.credential === "none"),
    false,
    "Every API call carries a credential",
  );
  assert.deepEqual(service.failures, []);
});
try {
  await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
} catch (error) {
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error(`PlanetScale ${mode} sign-in proof failed; private evidence retained.`);
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, "outcomes.json"), JSON.stringify(outcomes, null, 2));
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(
      {
        code: process.exitCode ?? 0,
        results: outcomes.map((outcome) => ({
          width: outcome.width,
          passed: outcome.status === "Success",
        })),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ directory, outcomes }));
}
