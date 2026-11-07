import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { planetScaleOAuthClient } from "../.upstream/apps/hosted/server/src/implementation/planetscale-oauth.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { startPlanetScaleCatalog } from "./planetscale-signin/catalog.mjs";
import {
  hostedClient,
  registrationDefault,
  serviceToken,
  startPlanetScale,
} from "./planetscale-signin/service.mjs";

/** The hosted app's reviewed permissions; the hosted client must ask for exactly these. */
const hostedScopes = [
  "read_user",
  "read_organization",
  "write_organization",
  "read_databases",
  "write_databases",
  "organization:create_databases",
  "organization:delete_databases",
  "organization:read_databases",
  "organization:write_databases",
  "organization:read_branches",
  "organization:write_branches",
  "organization:delete_branches",
  "organization:read_deploy_requests",
  "organization:write_deploy_requests",
  "organization:approve_deploy_requests",
  "organization:deploy_deploy_requests",
  "organization:read_backups",
  "organization:write_backups",
  "organization:delete_backups",
  "organization:restore_backups",
  "organization:manage_passwords",
  "organization:manage_read_only_passwords",
  "organization:read_workflows",
  "organization:write_workflows",
  "organization:read_audit_logs",
  "user:read_organizations",
  "organization:promote_branches",
  "database:demote_branches",
  "organization:write_members",
  "organization:manage_sso",
  "organization:read_payment_method",
  "organization:write_payment_method",
  "organization:read_invoices",
];
const sorted = (values) => [...values].sort();
const legacyOperations = JSON.parse(
  await readFile(join(import.meta.dirname, "planetscale-signin/legacy-operations.json"), "utf8"),
);
const legacyNames = legacyOperations.map((operation) => operation.name);
const api = legacyOperations.filter((operation) => operation.oauthScopes.length > 0).map((operation) => operation.name);
const tokenOnly = legacyOperations.filter((operation) => operation.oauthScopes.length === 0).map((operation) => `serviceToken.${operation.name}`);
const limited = legacyOperations.filter((operation) => operation.oauthScopes.some((scope) => registrationDefault.includes(scope))).map((operation) => operation.name);

const mode = process.argv[3] ?? "hosted";
assert.ok(
  mode === "hosted" ||
    mode === "dcr" ||
    mode === "unknown" ||
    mode === "refused" ||
    mode === "unreported",
  "Mode is hosted, dcr, unknown, refused or unreported",
);
const usesDcr = mode === "dcr" || mode === "unknown";
const hasHostedClient = !usesDcr;
const omitsGrantedScope = mode === "unknown" || mode === "unreported";
const refusedScope = "organization:write_branches";
const widths = ["unknown", "refused", "unreported"].includes(mode) ? [1280] : [1280, 390];
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
const dialogName = /^Connect PlanetScale(?: · .+)?$/;
const program = Effect.gen(function* () {
  const start = (acquire) =>
    Effect.acquireRelease(Effect.promise(acquire), (fixture) => Effect.promise(fixture.stop));
  const service = yield* start(() =>
    startPlanetScale({
      dcr: usesDcr,
      advertised: hasHostedClient ? ["read_user"] : metadata.scopes_supported,
      omitGrantedScope: omitsGrantedScope,
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
  assert.deepEqual(sorted(planetScaleOAuthClient.allowedScopes), sorted(hostedScopes));
  assert.equal(planetScaleOAuthClient.requireScopeConfirmation, true);
  // The reviewed client, moved to the loopback service as the Slack proof moves its client.
  const fixtureClient = {
    ...planetScaleOAuthClient,
    id: "planetscale-e2e",
    label: "Synthetic PlanetScale",
    requireScopeConfirmation: true,
    server: {
      ...planetScaleOAuthClient.server,
      issuer: service.origin,
      authorizationUrl: `${service.origin}/oauth/authorize`,
      tokenUrl: `${service.origin}/oauth/token`,
    },
    placement: { hosts: [new URL(service.origin).host] },
  };
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
          EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([fixtureClient]),
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
  const noOverflow = async (page) =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "No horizontal overflow",
    );
  const openConnect = async (page) => {
    await page
      .getByRole("region", { name: "Your accounts", exact: true })
      .getByRole("region", { name: "PlanetScale · Sign in", exact: true })
      .getByRole("button", { name: /^Connect new account/ })
      .click();
    return page.getByRole("dialog", { name: dialogName });
  };
  for (const width of widths) {
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.login(session);
        yield* browser.use(`Open PlanetScale at ${width}`, async (page) => {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
          await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
        });
        yield* browser.use("One connect starts with PlanetScale sign-in", async (page) => {
          const dialog = await openConnect(page);
          await dialog
            .getByRole("button", { name: "Sign in with PlanetScale", exact: true })
            .waitFor();
          await dialog
            .getByText(
              "Sign in to manage your PlanetScale databases, branches and deploy requests.",
              {
                exact: true,
              },
            )
            .waitFor();
          await dialog.getByText("What does sign-in connect?", { exact: true }).click();
          await dialog.getByText(/Keyspaces, safe migrations, cluster settings/).waitFor();
          await noOverflow(page);
        });
        yield* browser.checkpoint(`PlanetScale sign-in ${mode} ${width}`);
        yield* browser.use("A service token is one click away with exact steps", async (page) => {
          const dialog = page.getByRole("dialog", { name: dialogName });
          await dialog
            .getByRole("button", { name: "Use a service token instead", exact: true })
            .click();
          const link = dialog.getByRole("link", {
            name: "Open PlanetScale's service token guide",
            exact: true,
          });
          assert.equal(
            await link.getAttribute("href"),
            "https://planetscale.com/docs/api/reference/service-tokens",
          );
          assert.equal(await dialog.getByLabel("Service token", { exact: true }).count(), 1);
          await dialog
            .getByText("Paste SERVICE_TOKEN_ID:SERVICE_TOKEN as one value, without Bearer.", {
              exact: true,
            })
            .waitFor();
          await noOverflow(page);
          await dialog
            .getByRole("button", { name: "Sign in with PlanetScale instead", exact: true })
            .click();
        });
        yield* browser.checkpoint(`PlanetScale service token guidance ${mode} ${width}`);
        yield* browser.use("Own OAuth app guidance names the Client ID", async (page) => {
          const dialog = page.getByRole("dialog", { name: dialogName });
          await dialog.getByText("Advanced", { exact: true }).click();
          await dialog
            .getByRole("checkbox", { name: "Use your own PlanetScale app for this account" })
            .check();
          const link = dialog.getByRole("link", {
            name: "Open PlanetScale's OAuth app guide",
            exact: true,
          });
          assert.equal(
            await link.getAttribute("href"),
            "https://planetscale.com/docs/api/reference/oauth",
          );
          await dialog
            .getByText("Use the Client ID, not the application's ID.", { exact: true })
            .waitFor();
          await noOverflow(page);
          await page.keyboard.press("Escape");
        });
        yield* browser.checkpoint(`PlanetScale own app guidance ${mode} ${width}`);

        const before = yield* links();
        if (mode === "refused" || mode === "unreported") {
          const connection = yield* request(
            "POST",
            `${path}/accounts/user/planetscaleSignIn/connections`,
            {},
          );
          const attempt = yield* request(
            "POST",
            `${prefix}/connections/${connection.connection}/oauth/start`,
            { method: "signIn" },
          );
          yield* browser.use(
            "A missing hosted permission is shown before saving an account",
            async (page) => {
              await page.goto(attempt.authorizationUrl);
              await page
                .getByRole("heading", { name: "PlanetScale test authorization", exact: true })
                .waitFor();
              await page.getByRole("button", { name: "Authorize", exact: true }).click();
              await page.getByText("Some access was not granted", { exact: true }).waitFor();
              await page
                .getByText("Your existing sign-in and connected apps still work.", { exact: true })
                .waitFor();
              if (omitsGrantedScope) {
                await page
                  .getByText(
                    "The service did not report its granted permissions. Ask the app owner to check the service's token response before trying again.",
                    { exact: true },
                  )
                  .waitFor();
              } else {
                await page.getByText("Not granted", { exact: true }).waitFor();
                await page.getByText(refusedScope, { exact: true }).waitFor();
              }
              await page.getByRole("link", { name: "Return to Accounts", exact: true }).waitFor();
              await page.getByText("Access details", { exact: true }).click();
              const detail = page
                .locator("details")
                .filter({ has: page.getByText("Access details", { exact: true }) });
              const values = (label) =>
                detail
                  .locator("dl > div")
                  .filter({ has: page.getByText(label, { exact: true }) })
                  .locator("dd li > span:last-child")
                  .allTextContents();
              assert.deepEqual(sorted(await values("Requested")), sorted(hostedScopes));
              if (omitsGrantedScope)
                await detail.getByText("Not reported by the service.", { exact: true }).waitFor();
              else
                assert.deepEqual(
                  sorted(await values("Granted")),
                  sorted(hostedScopes.filter((scope) => scope !== refusedScope)),
                );
              await noOverflow(page);
            },
          );
          const failure = yield* request(
            "GET",
            `${prefix}/connections/${connection.connection}`,
          );
          assert.equal(failure.state.status, "pending");
          assert.equal(failure.state.failure.error.reason, "scope_missing");
          assert.deepEqual(
            sorted(failure.state.failure.error.requestedScopes),
            sorted(hostedScopes),
          );
          if (omitsGrantedScope) {
            assert.equal(failure.state.failure.error.grantedScopes, undefined);
            assert.deepEqual(
              sorted(failure.state.failure.error.missingScopes),
              sorted(hostedScopes),
            );
            assert.equal(failure.state.failure.error.grantedScopesKnown, false);
          } else {
            assert.deepEqual(
              sorted(failure.state.failure.error.grantedScopes),
              sorted(hostedScopes.filter((scope) => scope !== refusedScope)),
            );
            assert.deepEqual(failure.state.failure.error.missingScopes, [refusedScope]);
            assert.equal(failure.state.failure.error.grantedScopesKnown, true);
          }
          assert.equal(failure.state.failure.error.scopeNamesOmitted, false);
          assert.deepEqual(added(before, yield* links()), [], "No account is saved or linked");
          yield* browser.checkpoint("PlanetScale refused hosted scope is explicit and recoverable");
          return;
        }
        yield* browser.use("Sign in once and approve at PlanetScale", async (page) => {
          const dialog = await openConnect(page);
          await dialog
            .getByRole("button", { name: "Sign in with PlanetScale", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "PlanetScale test authorization", exact: true })
            .waitFor();
          await page.getByRole("button", { name: "Authorize", exact: true }).click();
          const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
          await naming
            .getByLabel("Account name", { exact: true })
            .fill(`PlanetScale ${mode} ${width}`);
          await naming.getByRole("button", { name: "Save name", exact: true }).click();
          await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
        });
        const [signedIn] = added(before, yield* links());
        assert.ok(signedIn, "Sign-in saves and links one account");
        assert.equal(signedIn.account.method, "signIn");
        const health = yield* request("POST", `${prefix}/accounts/${signedIn.account.id}/health`);
        assert.equal(health.apps.find((check) => check.app === app.id)?.check?.status, "healthy");

        // Tools follow the reported grant: nothing PlanetScale did not grant is listed or reachable.
        const oauthTools = yield* listed();
        const expectedOauthTools =
          mode === "unknown" ? legacyNames : mode === "hosted" ? api : limited;
        assert.deepEqual(
          oauthTools,
          sorted([...expectedOauthTools, "permissions"]),
        );
        const read = yield* call("databases.listDatabases", signedIn.account.id, {
          organization: "acme",
        });
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert.deepEqual(read.body, { operation: "list_databases", credential: "oauth" });
        const write = yield* call("databaseBranches.demoteBranch", signedIn.account.id, {
          organization: "acme",
          database: "app",
          branch: "main",
        });
        if (mode !== "dcr") {
          assert.equal(write.status, 409, "Every PlanetScale change needs approval");
          assert.equal(write.body._tag, "ToolApprovalRequired");
        } else
          assert.ok(write.status >= 400 && write.status < 500, "An ungranted write is refused");
        assert.equal(apiCalls("demote_branch").length, 0, "No write reached PlanetScale");
        const forToken = yield* call(
          "serviceToken.serviceTokens.listServiceTokens",
          signedIn.account.id,
          {
            organization: "acme",
          },
        );
        assert.ok(
          forToken.status >= 400 && forToken.status < 500,
          "OAuth never reaches token-only tools",
        );
        // The permissions tool belongs to the app, not to one account.
        const permissions = yield* client.request(session, "POST", `${path}/tools/call`, {
          tool: "permissions",
          input: {},
        });
        assert.equal(permissions.status, 200, JSON.stringify(permissions.body));
        const own = permissions.body.find((row) => row.accountId === signedIn.account.id);
        if (omitsGrantedScope) {
          assert.equal(
            own.permissions,
            "Unknown: PlanetScale did not report this account's permissions.",
          );
          assert.equal(own.unavailableTools, null);
        } else {
          const granted = mode === "hosted" ? hostedScopes : registrationDefault;
          for (const scope of granted)
            assert.ok(own.permissions.includes(scope), `${scope} is reported`);
          assert.ok(own.unavailableTools.includes("serviceToken.serviceTokens.listServiceTokens"));
        }

        yield* browser.use("Tools show the missing service-token section", async (page) => {
          await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`);
          const section = page.getByRole("region", {
            name: "PlanetScale service-token tools",
            exact: true,
          });
          await section.waitFor();
          await section.getByText(/aren't available through sign-in/).waitFor();
          await noOverflow(page);
        });
        yield* browser.checkpoint(`PlanetScale tools after sign-in ${mode} ${width}`);
        const tokensBefore = yield* links();
        yield* browser.use("Add service token opens the token form in one click", async (page) => {
          await page.getByRole("button", { name: "Add service token", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: dialogName });
          await dialog.getByLabel("Service token", { exact: true }).fill(serviceToken);
          await dialog.locator('button[type="submit"]').click();
          await dialog.getByText(/Signed in as acme/).waitFor();
          await dialog.getByRole("button", { name: "Continue", exact: true }).click();
          const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
          await naming
            .getByLabel("Account name", { exact: true })
            .fill(`PlanetScale token ${width}`);
          await naming.getByRole("button", { name: "Save name", exact: true }).click();
          await page
            .getByRole("region", { name: "PlanetScale service-token tools", exact: true })
            .waitFor({ state: "hidden" });
        });
        yield* browser.checkpoint(`PlanetScale with a service token ${mode} ${width}`);
        const [token] = added(tokensBefore, yield* links());
        assert.ok(token, "The token saves and links one account");
        assert.equal(token.account.method, "token");
        assert.deepEqual(yield* listed(), sorted([...legacyNames, ...tokenOnly, "permissions"]));
        assert.equal(legacyNames.length, 291);
        if (mode === "hosted" && width === 1280) {
          const apiCallsBeforeResolution = service.calls.filter((entry) => entry.phase === "api").length;
          for (const name of legacyNames) {
            const resolved = yield* getTool(name);
            assert.equal(resolved.status, 200, `${name} did not resolve: ${JSON.stringify(resolved.body)}`);
            assert.equal(resolved.body.name, name, `${name} resolved under a different name`);
          }
          assert.equal(
            service.calls.filter((entry) => entry.phase === "api").length,
            apiCallsBeforeResolution,
            "Resolving every legacy tool name does not execute a PlanetScale operation",
          );
        }
        const tokenRead = yield* call(
          "serviceToken.serviceTokens.listServiceTokens",
          token.account.id,
          {
            organization: "acme",
          },
        );
        assert.equal(tokenRead.status, 200, JSON.stringify(tokenRead.body));
        assert.deepEqual(tokenRead.body, { operation: "list_service_tokens", credential: "token" });

        // Unlinking the token restores the prompt; the signed-in account and its tools remain.
        yield* request("DELETE", `${path}/accounts/user/planetscale/${token.account.id}`);
        yield* request("DELETE", `${prefix}/accounts/${token.account.id}`);
        assert.deepEqual(yield* listed(), oauthTools);
        yield* browser.use("Unlink restores the service-token prompt", async (page) => {
          await page.reload();
          await page.getByRole("button", { name: "Add service token", exact: true }).waitFor();
        });
        yield* request("DELETE", `${path}/accounts/user/planetscale/${signedIn.account.id}`);
        yield* request("DELETE", `${prefix}/accounts/${signedIn.account.id}`);
      }).pipe(
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
    outcomes.push({ width, status: result._tag });
  }
  assert.ok(
    outcomes.every((result) => result.status === "Success"),
    JSON.stringify(outcomes),
  );
  const phase = (name) => service.calls.filter((entry) => entry.phase === name);
  if (hasHostedClient) {
    assert.equal(phase("register").length, 0, "A configured hosted client never registers");
    assert.ok(phase("authorize").length > 0);
    for (const authorize of phase("authorize")) {
      assert.equal(authorize.client, hostedClient.id);
      assert.deepEqual(
        sorted(authorize.scope.split(" ")),
        sorted(hostedScopes),
        "Exactly the hosted scopes",
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
