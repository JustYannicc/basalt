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
import { Browser } from "../.upstream/e2e/support/browser.ts";
import { scenarioEvidence, Telemetry } from "../.upstream/e2e/support/evidence.ts";
import { RecordingFocus } from "../.upstream/e2e/support/recording-focus.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { verifyLocalGuidance } from "./management-signin/local-guidance.mjs";
import { managementBrowser } from "./management-signin/browser.mjs";
import { startManagementCatalog } from "./management-signin/catalog.mjs";
import { retainWorkOSKey } from "./management-signin/retained-key.mjs";
import { verifyManualGuidance } from "./management-signin/manual-guidance.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const phase = process.argv[3] ?? "signin";
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/workos-sign-in", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(upstream);
const outcomes = [];
const program = Effect.gen(function* () {
  const fixture = yield* Effect.acquireRelease(Effect.promise(startManagementCatalog), (fixture) =>
    Effect.promise(fixture.stop),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      writeFile(
        join(directory, "provider-observations.json"),
        JSON.stringify(
          {
            calls: fixture.provider.calls,
            failures: fixture.provider.failures,
            registrations: fixture.provider.registrations(),
            exchanges: fixture.provider.exchanges(),
          },
          null,
          2,
        ),
      ),
    ),
  );
  if (phase === "local") {
    yield* verifyLocalGuidance({ fixture, directory });
    outcomes.push({ target: "local", width: 390, status: "Success" });
    return;
  }
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "WorkOS connection guidance");
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
      organization: "workos-sign-in",
      namePrefix: "workos",
    }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_CATALOG_URL: `${fixture.origin}/catalog/index.json`,
    E2E_HTTPS_APP_ORIGINS: "true",
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([
      fixture.origin,
      fixture.provider.rest,
      new URL(fixture.provider.mcp).origin,
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
  const installed = yield* api.request(session, "POST", `${prefix}/apps/install`, {
    entry: "workos",
    name: "WorkOS",
  });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const app = installed.body;
  const retained =
    phase === "signin" ? yield* retainWorkOSKey({ fixture, request, prefix, app }) : undefined;
  for (const width of [1280, 390]) {
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.login(session);
        yield* browser.use(`Open WorkOS at ${width}`, async (page) => {
          const stylesheetFailures = [];
          page.on("requestfailed", (request) => {
            if (request.resourceType() === "stylesheet")
              stylesheetFailures.push({
                url: request.url(),
                failure: request.failure()?.errorText,
              });
          });
          await page.setViewportSize({ width, height: 844 });
          await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
          await page.waitForFunction(() => {
            const styles = [...document.querySelectorAll('link[rel="stylesheet"]')];
            return styles.length > 0 && styles.every((link) => link.sheet !== null);
          });
          assert.deepEqual(stylesheetFailures, [], "The visual proof requires every stylesheet");
          assert.match(
            await page.locator("body").evaluate((body) => getComputedStyle(body).fontFamily),
            /Geist|sans-serif/i,
          );
          const region = page.getByRole("region", { name: "Your accounts", exact: true });
          await region
            .getByRole("button", {
              name:
                phase === "signin"
                  ? "Connect new account for WorkOS · Sign in"
                  : "Connect new account",
              exact: true,
            })
            .first()
            .click();
          const dialog = page.getByRole("dialog", { name: /^Connect WorkOS(?: · Sign in)?$/ });
          await dialog.locator("form").waitFor();
        });
        yield* browser.checkpoint(`WorkOS before guidance ${width}`);
        if (phase === "signin") {
          yield* browser.use(
            "WorkOS offers official sign-in and its key alternative",
            async (page) => {
              const dialog = page.getByRole("dialog", { name: /^Connect WorkOS(?: · Sign in)?$/ });
              assert.equal(
                await dialog
                  .getByRole("button", { name: "Sign in with WorkOS", exact: true })
                  .count(),
                1,
                "WorkOS must start with official management sign-in",
              );
              await dialog
                .getByRole("button", { name: "Use an API key instead", exact: true })
                .click();
              await dialog.locator('input[type="password"]').waitFor();
            },
          );
        }
        yield* browser.use("The API key has a usable setup guide", async (page) => {
          const dialog = page.getByRole("dialog", { name: /^Connect WorkOS(?: · Sign in)?$/ });
          assert.equal(
            await dialog.getByRole("link", { name: "Open WorkOS API keys", exact: true }).count(),
            1,
            "WorkOS API-key setup must link to the exact dashboard page",
          );
          assert.equal(
            await dialog.getByLabel("API key", { exact: true }).count(),
            1,
            "The WorkOS key field must name the required key",
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            "No horizontal overflow",
          );
        });
        yield* browser.checkpoint(`WorkOS API key ${width}`);
        if (phase === "signin") {
          const saved = (rows) =>
            rows
              .map((row) => [row.id, row.provider, row.method, row.label])
              .sort((left, right) => left[0].localeCompare(right[0]));
          const savedBefore = saved(yield* request("GET", `${prefix}/resources/accounts`));
          yield* browser.use("Return to sign-in without creating an account", async (page) => {
            await page.getByRole("button", { name: "Sign in instead", exact: true }).click();
            await page.getByRole("button", { name: "Sign in with WorkOS", exact: true }).waitFor();
          });
          yield* browser.omitNetworkTrace;
          for (const decision of ["Cancel sign-in", "Refuse access"]) {
            yield* browser.use(`WorkOS ${decision}`, async (page) => {
              await page.getByRole("button", { name: "Sign in with WorkOS", exact: true }).click();
              await page
                .getByRole("heading", { name: "WorkOS test workspace", exact: true })
                .waitFor();
              await page.getByRole("button", { name: decision, exact: true }).click();
              const dialog = page.getByRole("dialog", { name: "Connect WorkOS", exact: true });
              await dialog
                .getByRole("button", { name: "Sign in with WorkOS", exact: true })
                .waitFor();
              await dialog
                .getByText(
                  decision === "Cancel sign-in"
                    ? "Sign-in was cancelled. No account was connected."
                    : "Your WorkOS team has disabled sign-in for connected tools. Ask a team admin to enable it in Authentication settings.",
                  { exact: true },
                )
                .waitFor();
              assert.equal(
                await page.getByText("Update client details", { exact: true }).count(),
                0,
              );
              await dialog
                .getByRole("button", { name: "Use an API key instead", exact: true })
                .waitFor();
            });
            yield* browser.checkpoint(`${decision} ${width}`);
            const links = yield* request("GET", `${prefix}/apps/${app.id}/accounts/user`);
            assert.equal(
              links.filter((link) => link.requirement === "signIn").length,
              0,
              "Cancellation and refusal save no account",
            );
            assert.deepEqual(
              saved(yield* request("GET", `${prefix}/resources/accounts`)),
              savedBefore,
              "Cancellation and refusal leave saved accounts unchanged",
            );
            yield* browser.use(
              "The key alternative remains reversible after a refusal",
              async (page) => {
                await page
                  .getByRole("button", { name: "Use an API key instead", exact: true })
                  .click();
                await page.getByLabel("API key", { exact: true }).waitFor();
                await page.getByRole("button", { name: "Sign in instead", exact: true }).click();
                await page
                  .getByRole("button", { name: "Sign in with WorkOS", exact: true })
                  .waitFor();
              },
            );
          }
          yield* browser.use(
            "Complete WorkOS authorization through the real callback",
            async (page) => {
              await page.getByRole("button", { name: "Sign in with WorkOS", exact: true }).click();
              await page.getByRole("button", { name: "Approve access", exact: true }).click();
              const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
              await naming.getByLabel("Account name", { exact: true }).fill(`WorkOS ${width}`);
              await naming.getByRole("button", { name: "Save name", exact: true }).click();
              await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
            },
          );
          yield* browser.checkpoint(`WorkOS sign-in complete ${width}`);
          const links = yield* request("GET", `${prefix}/apps/${app.id}/accounts/user`);
          const signedIn = links.filter((link) => link.requirement === "signIn");
          assert.equal(signedIn.length, 1, "Approval saves and links exactly one OAuth account");
          const account = signedIn[0].account;
          assert.equal(account.method, "oauth");
          const health = yield* request("POST", `${prefix}/accounts/${account.id}/health`);
          assert.equal(health.apps.find((check) => check.app === app.id)?.check?.status, "healthy");
          const read = yield* request("POST", `${prefix}/apps/${app.id}/tools/call`, {
            tool: "list_organizations",
            input: { accountId: account.id, input: {} },
          });
          assert.equal(read.isError ?? false, false);
          assert.deepEqual(JSON.parse(read.content.find((item) => item.type === "text").text), {
            transport: "mcp",
            tool: "list_organizations",
          });
          const mutation = yield* api.request(
            session,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "delete_organization", input: { accountId: account.id, input: {} } },
          );
          assert.equal(mutation.status, 409, "MCP mutations need approval");
          assert.equal(mutation.body._tag, "ToolApprovalRequired");
          const restMutation = yield* api.request(
            session,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "fixture.write", input: { accountId: retained.account.id, input: {} } },
          );
          assert.equal(restMutation.status, 409, "Retained REST mutations still need approval");
          assert.equal(restMutation.body._tag, "ToolApprovalRequired");
          const wrongAccount = yield* api.request(
            session,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "list_organizations", input: { accountId: retained.account.id, input: {} } },
          );
          assert.equal(wrongAccount.status, 422, "An API key cannot authorize MCP tools");
          assert.equal(
            fixture.provider.calls.some((call) => call.tool === "delete_organization"),
            false,
          );
          assert.deepEqual(yield* retained.read(), { transport: "rest", retainedKey: true });
          yield* request("DELETE", `${prefix}/apps/${app.id}/accounts/user/signIn/${account.id}`);
          yield* request("DELETE", `${prefix}/accounts/${account.id}`);
          const beforeManual = saved(yield* request("GET", `${prefix}/resources/accounts`));
          yield* verifyManualGuidance(browser, width);
          assert.deepEqual(
            saved(yield* request("GET", `${prefix}/resources/accounts`)),
            beforeManual,
            "Leaving manual setup saves nothing",
          );
        }
      }).pipe(
        Effect.timeout("60 seconds"),
        Effect.scoped,
        Effect.provide(Browser.layer),
        Effect.provide(
          scenarioEvidence({ file: "e2e/workos-sign-in.mjs", name: `WorkOS guidance ${width}` }),
        ),
        Effect.provide(Telemetry.layer),
        Effect.provide(RecordingFocus.layer),
        Effect.provide(managementBrowser(server.tlsCertificate)),
        Effect.provideService(Target, target),
      ),
    );
    outcomes.push({ width, status: result._tag });
  }
  if (phase === "signin") {
    yield* verifyLocalGuidance({ fixture, directory });
    outcomes.push({ target: "local", width: 390, status: "Success" });
  }
  assert.ok(
    outcomes.every((result) => result.status === "Success"),
    JSON.stringify(outcomes),
  );
  assert.equal(
    fixture.provider.calls
      .filter((call) => call.transport === "rest")
      .every((call) => call.validCredential),
    true,
  );
  assert.equal(
    fixture.provider.calls
      .filter((call) => call.transport === "mcp")
      .every((call) => call.validCredential),
    true,
  );
  assert.equal(
    fixture.provider.calls.some((call) => call.path === "/fixture/write"),
    false,
  );
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
  console.error("WorkOS sign-in proof failed; private evidence retained.");
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, "outcomes.json"), JSON.stringify(outcomes, null, 2));
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(
      {
        code: process.exitCode ?? 0,
        phase,
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
