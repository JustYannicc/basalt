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
import { restToken, startGitLabInstance } from "./gitlab-signin/instance.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/gitlab-sign-in", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(upstream);
const outcomes = [];
const dialogName = /^Connect GitLab(?: · .+)?$/;
const program = Effect.gen(function* () {
  const start = (acquire) =>
    Effect.acquireRelease(Effect.promise(acquire), (fixture) => Effect.promise(fixture.stop));
  const catalog = yield* start(startGitLabCatalog);
  // One self-managed instance advertises registration; the other requires its own app.
  const automatic = yield* start(() => startGitLabInstance({ dcr: true }));
  const manual = yield* start(() => startGitLabInstance({ dcr: false }));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      writeFile(
        join(directory, "instance-observations.json"),
        JSON.stringify(
          {
            automatic: { calls: automatic.calls, failures: automatic.failures },
            manual: { calls: manual.calls, failures: manual.failures },
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
  const added = (before, after) =>
    after.filter((link) => !before.some((old) => old.account.id === link.account.id));
  // Open the sign-in requirement and choose a self-managed instance in place of GitLab.com.
  const openAt = async (page, origin) => {
    const region = page.getByRole("region", { name: "Your accounts", exact: true });
    await region
      .getByRole("button", { name: "Connect new account for GitLab · Sign in", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: dialogName });
    await dialog.getByText("Using https://gitlab.com", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Use another instance", exact: true }).click();
    await dialog.getByLabel("GitLab instance URL", { exact: true }).fill(origin);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await dialog.getByText(`Using ${origin}`, { exact: true }).waitFor();
    return dialog;
  };
  const noOverflow = async (page) =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "No horizontal overflow",
    );
  for (const width of [1280, 390]) {
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.login(session);
        yield* browser.use(`Open GitLab at ${width}`, async (page) => {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
          await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
        });
        yield* browser.use(
          "GitLab starts with MCP sign-in on the chosen instance",
          async (page) => {
            const dialog = await openAt(page, automatic.origin);
            await dialog
              .getByRole("button", { name: "Sign in with GitLab", exact: true })
              .waitFor();
            await dialog
              .getByText("Sign in to use GitLab's MCP tools on this instance.", { exact: true })
              .waitFor();
            assert.equal(
              await dialog.getByRole("link", { name: /^Open GitLab/ }).count(),
              0,
              "Advertised registration needs no GitLab app setup",
            );
            await dialog.getByText("What does sign-in connect?", { exact: true }).click();
            await dialog.getByText(/none of the REST API tools/).waitFor();
            await noOverflow(page);
          },
        );
        yield* browser.checkpoint(`GitLab sign-in ${width}`);
        yield* browser.use("A personal access token opens on the same instance", async (page) => {
          const dialog = page.getByRole("dialog", { name: dialogName });
          await dialog
            .getByRole("button", {
              name: "Use a personal access token for the full API",
              exact: true,
            })
            .click();
          await dialog.getByText(`Using ${automatic.origin}`, { exact: true }).waitFor();
          const link = dialog.getByRole("link", {
            name: "Open GitLab personal access tokens",
            exact: true,
          });
          assert.equal(
            await link.getAttribute("href"),
            `${automatic.origin}/-/user_settings/personal_access_tokens`,
            "The token page must open on the selected instance",
          );
          assert.equal(
            await dialog.getByLabel("Personal access token", { exact: true }).count(),
            1,
          );
          await dialog
            .getByText("Paste the token only, without Bearer.", { exact: true })
            .waitFor();
          await dialog.getByText(/Select the api scope for full REST API access/).waitFor();
          await dialog
            .getByText(/Your administrator can turn off personal access tokens/)
            .first()
            .waitFor();
          await noOverflow(page);
        });
        yield* browser.checkpoint(`GitLab personal access token ${width}`);
        const tokensBefore = yield* links("gitlab");
        yield* browser.use("Save the token for the selected instance", async (page) => {
          const dialog = page.getByRole("dialog", { name: dialogName });
          await dialog.getByLabel("Personal access token", { exact: true }).fill(restToken);
          await dialog.locator('button[type="submit"]').click();
          await dialog.getByText("Signed in as synthetic", { exact: true }).waitFor();
          await dialog.getByRole("button", { name: "Continue", exact: true }).click();
          const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
          await naming.getByLabel("Account name", { exact: true }).fill(`GitLab token ${width}`);
          await naming.getByRole("button", { name: "Save name", exact: true }).click();
          await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
        });
        const [token] = added(tokensBefore, yield* links("gitlab"));
        assert.ok(token, "The token saves and links one REST account");
        assert.equal(token.account.method, "token");
        assert.equal(token.account.site, automatic.origin);
        const tokenHealth = yield* request("POST", `${prefix}/accounts/${token.account.id}/health`);
        assert.equal(
          tokenHealth.apps.find((check) => check.app === app.id)?.check?.status,
          "healthy",
        );
        const rest = yield* call("fixture.read", token.account.id);
        assert.equal(rest.status, 200, JSON.stringify(rest.body));
        assert.deepEqual(rest.body, {
          transport: "rest",
          site: automatic.origin,
        });

        const signInBefore = yield* links("signIn");
        yield* browser.use(
          "Switching back keeps the instance, then sign-in registers",
          async (page) => {
            const dialog = await openAt(page, automatic.origin);
            await dialog
              .getByRole("button", {
                name: "Use a personal access token for the full API",
                exact: true,
              })
              .click();
            await dialog
              .getByRole("button", { name: "Sign in with GitLab instead", exact: true })
              .click();
            await dialog.getByText(`Using ${automatic.origin}`, { exact: true }).waitFor();
            await dialog.getByRole("button", { name: "Sign in with GitLab", exact: true }).click();
            await page
              .getByRole("heading", { name: "GitLab test instance", exact: true })
              .waitFor();
            await page.getByRole("button", { name: "Authorize", exact: true }).click();
            const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
            await naming.getByLabel("Account name", { exact: true }).fill(`GitLab MCP ${width}`);
            await naming.getByRole("button", { name: "Save name", exact: true }).click();
            await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
          },
        );
        yield* browser.checkpoint(`GitLab sign-in complete ${width}`);
        const [signedIn] = added(signInBefore, yield* links("signIn"));
        assert.ok(signedIn, "Approval saves and links one MCP account");
        assert.equal(signedIn.account.method, "mcp");
        assert.equal(signedIn.account.site, automatic.origin);
        const health = yield* request("POST", `${prefix}/accounts/${signedIn.account.id}/health`);
        assert.equal(health.apps.find((check) => check.app === app.id)?.check?.status, "healthy");
        const mcpTool = yield* call("search", signedIn.account.id);
        assert.equal(mcpTool.status, 409, "Every GitLab MCP tool call needs approval");
        assert.equal(mcpTool.body._tag, "ToolApprovalRequired");
        const restFromMcp = yield* call("fixture.read", signedIn.account.id);
        assert.equal(restFromMcp.status, 422, "An mcp-scoped sign-in cannot authorize REST tools");
        const mcpFromToken = yield* call("search", token.account.id);
        assert.equal(mcpFromToken.status, 422, "A REST token cannot authorize MCP tools");

        yield* browser.use(
          "Without registration, sign-in explains the own-app setup",
          async (page) => {
            const dialog = await openAt(page, manual.origin);
            await dialog
              .getByText(/doesn't offer automatic app registration for sign-in/)
              .waitFor();
            await dialog.getByText("Advanced", { exact: true }).click();
            await dialog
              .getByRole("checkbox", { name: "Use your own GitLab app for this account" })
              .check();
            const link = dialog.getByRole("link", {
              name: "Open GitLab applications",
              exact: true,
            });
            assert.equal(
              await link.getAttribute("href"),
              `${manual.origin}/-/user_settings/applications`,
              "The applications page must open on the selected instance",
            );
            await dialog.getByText(/clear Confidential and select the mcp scope/).waitFor();
            await dialog.getByText("Use GitLab's Application ID.", { exact: true }).waitFor();
            await noOverflow(page);
          },
        );
        yield* browser.checkpoint(`GitLab own app for sign-in ${width}`);
        yield* browser.use("Leave own-app setup without saving", async (page) =>
          page.keyboard.press("Escape"),
        );
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
    automatic.calls
      .filter((item) => item.phase === "authorize")
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
  assert.deepEqual([...automatic.failures, ...manual.failures], []);
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
