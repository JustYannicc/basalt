import assert from "node:assert/strict";
import { Context, Effect, Layer, Redacted } from "effect";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../../.upstream/e2e/support/managed-server.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { Browser, BrowserDriver } from "../../.upstream/e2e/support/browser.ts";
import { scenarioEvidence, Telemetry } from "../../.upstream/e2e/support/evidence.ts";
import { RecordingFocus } from "../../.upstream/e2e/support/recording-focus.ts";
import { restToken } from "./instance.mjs";

/** The local client retains an instance across all methods and checks tokens there before saving. */
export const verifyLocalGitLabGuidance = ({ catalog, instance, directory }) =>
  Effect.gen(function* () {
    const outcomes = [];
    const base = yield* startEnvironment({ target: "local", headless: true }),
      registry = yield* lockedNpmRegistry;
    const prepared = yield* prepareScenario(base.target, "Local GitLab selected instance");
    const server = yield* startManagedServer(prepared, "product", {
      EXECUTOR_NPM_REGISTRY: registry.url,
      EXECUTOR_CATALOG_URL: catalog.origin + "/catalog/index.json",
      EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
      EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([catalog.origin, instance.origin]),
      EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true",
    });
    const target = Target.of({
      ...prepared,
      evidenceDirectory: directory,
      controlOrigin: server.controlOrigin,
      metadata: { ...prepared.metadata, origin: server.origin },
    });
    const services = yield* Layer.build(
      SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
    );
    const api = Context.get(services, SessionClients),
      session = yield* api.session();
    const request = (method, path, data) =>
      session
        .send(method, path, data, { authorization: `Bearer ${Redacted.value(target.apiKey)}` })
        .pipe(
          Effect.map((r) => {
            assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`);
            return r.body;
          }),
        );
    const app = yield* request("POST", "/dashboard/api/catalog/import", {
      entry: "gitlab",
      name: "GitLab",
    });
    const accounts = () =>
      request("GET", "/dashboard/api/overview").pipe(
        Effect.map((x) => x.accounts.map((a) => a.id).sort()),
      );
    const before = yield* accounts();
    for (const width of [1280, 390]) {
      const paired = yield* request("POST", "/auth/pair");
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const browser = yield* Browser;
          yield* browser.use("Pair the local GitLab client", async (page) => {
            await page.goto(paired.url);
            await page.getByRole("heading", { name: /^Apps/ }).waitFor();
            await page.setViewportSize({ width, height: 844 });
            await page.goto(`/apps/${app.id}?view=accounts`);
            await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
          });
          const open = async (page, origin) => {
            await page
              .getByRole("region", { name: "Your accounts", exact: true })
              .getByRole("region", { name: "GitLab", exact: true })
              .getByRole("button", { name: "Connect new account", exact: true })
              .click();
            await page
              .getByRole("menuitem", { name: "Sign in with GitLab MCP", exact: true })
              .click();
            const d = page.getByRole("dialog");
            await d.getByRole("button", { name: "Use another instance", exact: true }).click();
            await d.getByLabel("GitLab instance URL", { exact: true }).fill(origin);
            await d.getByRole("button", { name: "Continue", exact: true }).click();
            await d.getByText(`Using ${origin}`, { exact: true }).waitFor();
            return d;
          };
          const startCalls = instance.calls.length;
          yield* browser.use(
            "Local switching keeps the selected instance before token preflight",
            async (page) => {
              const d = await open(page, instance.origin);
              await d
                .getByRole("button", {
                  name: "Use a personal access token for the full API",
                  exact: true,
                })
                .click();
              await d.getByLabel("Personal access token", { exact: true }).waitFor();
              assert.equal(
                await d.getByText(`Using ${instance.origin}`, { exact: true }).count(),
                1,
                "Local method switching must retain the chosen instance",
              );
              await d.getByLabel("Personal access token", { exact: true }).fill(restToken);
              await d.locator('button[type="submit"]').click();
              await d.getByText(/Signed in as synthetic/).waitFor();
            },
          );
          yield* browser.checkpoint(`Local selected-instance token preflight ${width}`);
          assert.ok(
            instance.calls
              .slice(startCalls)
              .some((c) => c.path === "/api/v4/user" && c.personalToken),
            "The selected instance receives the token health check",
          );
          yield* browser.use(
            "Return to MCP at the selected local instance, then cancel",
            async (page) => {
              const dialog = page.getByRole("dialog");
              await dialog
                .getByRole("button", { name: "Sign in with GitLab MCP instead", exact: true })
                .click();
              await dialog.getByText(`Using ${instance.origin}`, { exact: true }).waitFor();
              await dialog
                .getByRole("button", { name: "Sign in with GitLab MCP", exact: true })
                .waitFor();
              await page.keyboard.press("Escape");
            },
          );
          // HTTPS hosts prove link rebasing; the running loopback instance proves discovery.
          for (const origin of ["https://first.example.test", "https://second.example.test"]) {
            yield* browser.use(
              "Local setup links and return to MCP keep the chosen HTTPS instance",
              async (page) => {
                const d = await open(page, origin);
                await d
                  .getByRole("button", {
                    name: "Use a personal access token for the full API",
                    exact: true,
                  })
                  .click();
                await d.getByLabel("Personal access token", { exact: true }).waitFor();
                assert.equal(
                  await d
                    .getByRole("link", { name: "Open GitLab personal access tokens", exact: true })
                    .getAttribute("href"),
                  origin + "/-/user_settings/personal_access_tokens",
                );
                await d
                  .getByRole("button", {
                    name: "Use your own GitLab app for the full API",
                    exact: true,
                  })
                  .click();
                await d.getByLabel("Client ID", { exact: true }).waitFor();
                assert.equal(
                  await d
                    .getByRole("link", { name: "Open GitLab applications", exact: true })
                    .getAttribute("href"),
                  origin + "/-/user_settings/applications",
                );
                await d
                  .getByRole("button", { name: "Sign in with GitLab MCP instead", exact: true })
                  .click();
                await d.getByText(`Using ${origin}`, { exact: true }).waitFor();
                await d
                  .getByRole("button", { name: "Sign in with GitLab MCP instead", exact: true })
                  .waitFor({ state: "hidden" });
                assert.equal(
                  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                  true,
                );
              },
            );
            yield* browser.checkpoint(
              `Local selected-instance guides ${width} ${origin.includes("first") ? "first" : "second"}`,
            );
            yield* browser.use("Cancel local setup", (page) => page.keyboard.press("Escape"));
          }
          assert.deepEqual(
            yield* accounts(),
            before,
            "Opening, switching, prechecking and cancelling save no accounts",
          );
        }).pipe(
          Effect.timeout("60 seconds"),
          Effect.scoped,
          Effect.provide(Browser.layer),
          Effect.provide(
            scenarioEvidence({
              file: "e2e/gitlab-sign-in.mjs",
              name: `Local GitLab instance ${width}`,
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
    return outcomes;
  });
