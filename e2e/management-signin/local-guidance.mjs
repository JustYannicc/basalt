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
import { verifyInstanceGuidance } from "./instance-guidance.mjs";
import { RecordingFocus } from "../../.upstream/e2e/support/recording-focus.ts";

/** The normal local product uses the same catalog guide and reversible method choices. */
export const verifyLocalGuidance = ({ fixture, directory }) =>
  Effect.gen(function* () {
    const base = yield* startEnvironment({ target: "local", headless: true });
    const registry = yield* lockedNpmRegistry;
    const prepared = yield* prepareScenario(base.target, "Local management connection guidance");
    const server = yield* startManagedServer(prepared, "product", {
      EXECUTOR_NPM_REGISTRY: registry.url,
      EXECUTOR_CATALOG_URL: `${fixture.origin}/catalog/index.json`,
      EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
      EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([
        fixture.origin,
        fixture.provider.rest,
        new URL(fixture.provider.mcp).origin,
      ]),
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
    const api = Context.get(services, SessionClients);
    const session = yield* api.session();
    const request = (method, path, data) =>
      session
        .send(method, path, data, {
          authorization: `Bearer ${Redacted.value(target.apiKey)}`,
        })
        .pipe(
          Effect.map((response) => {
            assert.equal(
              response.status,
              200,
              `${method} ${path}: ${JSON.stringify(response.body)}`,
            );
            return response.body;
          }),
        );
    const installed = yield* request("POST", "/dashboard/api/catalog/import", {
      entry: "workos",
      name: "WorkOS",
    });
    const instance = yield* request("POST", "/dashboard/api/catalog/import", {
      entry: "instance-guide",
      name: "Instance guide",
    });
    const before = (yield* request("GET", "/dashboard/api/overview")).accounts;
    const paired = yield* request("POST", "/auth/pair");
    yield* Effect.gen(function* () {
      const browser = yield* Browser;
      yield* browser.use("Pair the normal local browser", async (page) => {
        await page.goto(paired.url);
        await page.getByRole("heading", { name: /^Apps/ }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/apps/${installed.id}?view=accounts`);
        const region = page.getByRole("region", { name: "Your accounts", exact: true });
        await region
          .getByRole("button", { name: "Connect new account for WorkOS · Sign in", exact: true })
          .click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Sign in with WorkOS", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Use an API key instead", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("API key", { exact: true }).waitFor();
        assert.equal(
          await dialog
            .getByRole("link", { name: "Open WorkOS API keys", exact: true })
            .getAttribute("href"),
          "https://dashboard.workos.com/api-keys",
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      });
      yield* browser.checkpoint("Local WorkOS key alternative 390");
      yield* browser.use("Return to sign-in and close without saving", async (page) => {
        await page.getByRole("button", { name: "Sign in instead", exact: true }).click();
        await page.getByRole("button", { name: "Sign in with WorkOS", exact: true }).waitFor();
        await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      });
      yield* verifyInstanceGuidance(browser, instance.id);
      assert.deepEqual(
        (yield* request("GET", "/dashboard/api/overview")).accounts,
        before,
        "Opening, switching and closing local setup saves no accounts",
      );
    }).pipe(
      Effect.timeout("60 seconds"),
      Effect.scoped,
      Effect.provide(Browser.layer),
      Effect.provide(
        scenarioEvidence({ file: "e2e/workos-sign-in.mjs", name: "Local WorkOS method choices" }),
      ),
      Effect.provide(Telemetry.layer),
      Effect.provide(RecordingFocus.layer),
      Effect.provide(BrowserDriver.layer),
      Effect.provideService(Target, target),
    );
  });
