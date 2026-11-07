import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Context, Effect, Layer, Redacted } from "effect";
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
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { startGitLabCatalog } from "./gitlab-signin/catalog.mjs";
import { verifyGitLabConnections } from "./gitlab-signin/journey.mjs";
import { verifyLocalGitLabGuidance } from "./gitlab-signin/local.mjs";
import { restToken, restOAuthClient, startGitLabInstance } from "./gitlab-signin/instance.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/gitlab-sign-in", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(upstream);
const outcomes = [];
const program = Effect.gen(function* () {
  const start = (acquire) =>
    Effect.acquireRelease(Effect.promise(acquire), (fixture) => Effect.promise(fixture.stop));
  const catalog = yield* start(startGitLabCatalog);
  // One self-managed instance advertises registration; the other requires its own app.
  const automatic = yield* start(() => startGitLabInstance({ dcr: true }));
  const manual = yield* start(() => startGitLabInstance({ dcr: false }));
  const disabled = yield* start(() => startGitLabInstance({ dcr: true, mcpEnabled: false }));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      writeFile(
        join(directory, "instance-observations.json"),
        JSON.stringify(
          {
            automatic: { calls: automatic.calls, failures: automatic.failures },
            manual: { calls: manual.calls, failures: manual.failures },
            disabled: { calls: disabled.calls, failures: disabled.failures },
          },
          null,
          2,
        ),
      ),
    ),
  );
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "GitLab connection guidance");
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
      organization: "gitlab-sign-in",
      namePrefix: "gitlab",
    }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_CATALOG_URL: `${catalog.origin}/catalog/index.json`,
    E2E_HTTPS_APP_ORIGINS: "true",
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([
      catalog.origin,
      automatic.origin,
      manual.origin,
      disabled.origin,
    ]),
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
  const api = Context.get(services, SessionClients);
  const session = yield* api.session(Redacted.make(actors.owner.cookies));
  const prefix = `/api/organizations/${actors.organization.id}`;
  const request = (method, path, data) =>
    api.request(session, method, path, data).pipe(
      Effect.map((response) => {
        assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
        return response.body;
      }),
    );
  const call = (tool, accountId) =>
    api.request(session, "POST", `${prefix}/apps/${app.id}/tools/call`, {
      tool,
      input: { accountId, input: {} },
    });
  const installed = yield* api.request(session, "POST", `${prefix}/apps/install`, {
    entry: "gitlab",
    name: "GitLab",
  });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const app = installed.body;
  assert.deepEqual(Object.keys(app.requirements.accounts).sort(), ["gitlab", "signIn"]);
  const links = (requirement) =>
    request("GET", `${prefix}/apps/${app.id}/accounts/user`).pipe(
      Effect.map((rows) => rows.filter((link) => link.requirement === requirement)),
    );
  for (const site of [`${automatic.origin}/unexpected-path`, "http://127.0.0.1:1"]) {
    const before = automatic.calls.length;
    const check = yield* request("POST", `${prefix}/apps/${app.id}/credential-checks`, {
      provider: app.requirements.accounts.gitlab.provider,
      method: "token",
      fields: { token: restToken },
      site,
    });
    assert.equal(check.status, "check_failed", "Preflight refuses an invalid or unapproved site");
    assert.equal(automatic.calls.length, before, "Rejected sites never receive credentials");
  }
  for (const width of [1280, 390]) {
    const result = yield* Effect.exit(
      verifyGitLabConnections({
        width,
        session,
        actors,
        app,
        automatic,
        manual,
        disabled,
        links,
        call,
        request,
        prefix,
      }).pipe(
        Effect.timeout("90 seconds"),
        Effect.scoped,
        Effect.provide(Browser.layer),
        Effect.provide(
          scenarioEvidence({ file: "e2e/gitlab-sign-in.mjs", name: `GitLab guidance ${width}` }),
        ),
        Effect.provide(Telemetry.layer),
        Effect.provide(RecordingFocus.layer),
        Effect.provide(BrowserDriver.layer),
        Effect.provideService(Target, target),
      ),
    );
    outcomes.push({ width, status: result._tag });
  }
  assert.ok(
    outcomes.every((result) => result.status === "Success"),
    JSON.stringify(outcomes),
  );
  assert.equal(automatic.registrations() > 0, true, "Advertised registration is used");
  assert.equal(manual.registrations(), 0, "Unadvertised registration is never attempted");
  assert.ok(
    disabled.calls.some((call) => call.phase === "disabled"),
    "The disabled MCP server is actually reached",
  );
  assert.ok(
    automatic.calls
      .filter((item) => item.phase === "authorize" && item.client !== restOAuthClient.id)
      .every((item) => item.scope === "mcp" && item.resource === `${automatic.origin}/api/v4/mcp`),
    "Sign-in asks only for the mcp scope on the instance's MCP server",
  );
  assert.equal(
    [...automatic.calls, ...manual.calls].some(
      (item) => item.transport === "rest" && item.mcpToken,
    ),
    false,
    "The MCP token is never sent to REST",
  );
  const local = yield* verifyLocalGitLabGuidance({
    catalog,
    instance: automatic,
    directory: join(directory, "local"),
  });
  outcomes.push(...local.map((outcome) => ({ client: "local", ...outcome })));
  assert.ok(
    outcomes.every((result) => result.status === "Success"),
    JSON.stringify(outcomes),
  );
  assert.deepEqual([...automatic.failures, ...manual.failures, ...disabled.failures], []);
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
  console.error("GitLab sign-in proof failed; private evidence retained.");
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
