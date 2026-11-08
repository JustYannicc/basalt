import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Context,
  Effect,
  Layer,
  NodeServices,
  FetchHttpClient,
  Redacted,
} from "./oauth-renewal-recovery/dependencies.mjs";
import { startEnvironment } from "../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../.upstream/e2e/support/managed-server.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { Api, SessionClients } from "../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../.upstream/e2e/support/npm-registry.ts";
import { oauthSetupIssuer } from "../.upstream/e2e/support/oauth-setup-issuer.ts";
import { controlRequest } from "../.upstream/e2e/support/server-control.ts";
import { Browser, BrowserDriver } from "../.upstream/e2e/support/browser.ts";
import { scenarioEvidence, Telemetry } from "../.upstream/e2e/support/evidence.ts";
import { RecordingFocus } from "../.upstream/e2e/support/recording-focus.ts";
import { settleWebhookSources } from "../.upstream/e2e/support/webhook-sources.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { appFiles, assertPrivate, connect } from "./oauth-renewal-recovery/fixture.mjs";
import { proveRecoveryUi, captureBeforeUi } from "./oauth-renewal-recovery/browser.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ??
    join(root, ".generated/oauth-renewal-recovery", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(upstream);
const outcomes = [];
let phase = "environment";
const save = (filename, value) =>
  writeFile(join(directory, filename), JSON.stringify(value, null, 2), { mode: 0o600 });

const program = Effect.gen(function* () {
  const issuer = yield* oauthSetupIssuer;
  yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "OAuth renewal recovery");
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
      organization: "renewal-recovery",
      namePrefix: "renewal",
    }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    E2E_HTTPS_APP_ORIGINS: "true",
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([issuer.origin]),
  });
  const target = Target.of({
    ...prepared,
    headless: true,
    evidenceDirectory: directory,
    controlOrigin: server.controlOrigin,
    ...(server.tlsCertificate === undefined ? {} : { tlsCertificate: server.tlsCertificate }),
    metadata: { ...prepared.metadata, origin: server.origin },
  });
  const services = yield* Layer.build(
    SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
  );
  const api = Context.get(services, SessionClients);
  const owner = yield* api.session(Redacted.make(actors.owner.cookies));
  const prefix = `/api/organizations/${actors.organization.id}`;
  const request = (method, path, data) =>
    api.request(owner, method, path, data).pipe(
      Effect.map((response) => {
        assert.equal(response.status, 200, `${method} ${path} returned HTTP ${response.status}`);
        return response.body;
      }),
    );
  phase = "deploy";
  const app = yield* request("POST", `${prefix}/apps/deploy`, {
    name: "Renewal recovery",
    files: appFiles(issuer.origin),
  });
  const appPath = `${prefix}/apps/${app.id}`;
  const label = "Synthetic renewal account";
  phase = "initial-connect";
  const account = yield* connect({ request, appPath, prefix, label });
  // App linking resolves credentials in background webhook setup. Finish that work first so
  // the measured refresh belongs to the health request, as in oauth-refresh-resilience.spec.ts.
  const settleLinks = () =>
    settleWebhookSources(owner, appPath, (sources) =>
      sources.some((source) => source.account === account.id && source.status !== "pending"),
    ).pipe(Effect.provideService(Api, api));
  yield* settleLinks();
  const healthPath = `${prefix}/accounts/${account.id}/health`;
  const linkSnapshot = () =>
    request("GET", `${appPath}/accounts/user`).pipe(
      Effect.map((links) => {
        assertPrivate(links);
        return links.map((link) => [link.requirement, link.account.id]).sort();
      }),
    );
  const accessSnapshot = () =>
    request("GET", `${prefix}/resources`).pipe(
      Effect.map((directory) => {
        const entry = directory.accounts.find((entry) => entry.account.id === account.id);
        assert.ok(entry, "Saved account missing from access directory");
        assert.equal(typeof entry.access.canManage, "boolean");
        assert.equal(typeof entry.access.canUse, "boolean");
        return { owner: entry.account.owner, access: entry.access };
      }),
    );
  const access = yield* accessSnapshot();
  const links = yield* linkSnapshot();
  assert.ok(links.some(([requirement, id]) => requirement === "service" && id === account.id));

  const journey = Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.login(owner);
    yield* browser.omitNetworkTrace;
    for (const scenario of [
      {
        name: "service-503",
        tokenError: { status: 503, body: { error_description: "PRIVATE_PROVIDER_ERROR" } },
        status: "upstream_unavailable",
        tag: "OAuthRenewalFailed",
        renewal: { reason: "service_unavailable", cause: { stage: "refresh", status: 503 } },
        reconnect: false,
        reason: /sign-in service is unavailable.*saved sign-in is kept/i,
      },
      {
        name: "invalid-request",
        tokenError: {
          status: 400,
          body: { error: "invalid_request", error_description: "PRIVATE_PROVIDER_ERROR" },
        },
        status: "upstream_unavailable",
        tag: "OAuthRenewalFailed",
        renewal: {
          reason: "renewal_rejected",
          cause: { stage: "refresh", status: 400, providerError: "invalid_request" },
        },
        reconnect: true,
        reason: /refused to renew.*without saying it ended/i,
      },
      {
        name: "invalid-grant",
        tokenError: {
          status: 400,
          body: { error: "invalid_grant", error_description: "PRIVATE_PROVIDER_ERROR" },
        },
        status: "credentials_rejected",
        tag: "OAuthReconnectRequired",
        renewal: { cause: { stage: "refresh", status: 400, providerError: "invalid_grant" } },
        reconnect: true,
        reason: /can no longer renew access.*Reconnect/i,
      },
    ]) {
      phase = scenario.name;
      // Make the server's real stored token expire. No wall-time sleep or token injection.
      yield* controlRequest("clock/advance", 200, { milliseconds: 60_000 });
      yield* issuer.configure({ tokenError: scenario.tokenError });
      const before = (yield* issuer.metrics).refreshes;
      const health = yield* request("POST", healthPath);
      assertPrivate(health);
      const check = health.apps.find((item) => item.app === app.id)?.check;
      assert.ok(check, `${scenario.name} omitted the app health check`);
      assert.equal(check.status, scenario.status, `${scenario.name} health classification`);
      assert.equal(check.current, true);
      assert.equal(check.failure.tag, scenario.tag);
      if (process.argv.includes("--before") || process.argv.includes("--legacy"))
        yield* captureBeforeUi({
          actors,
          directory,
          label,
          legacy: process.argv.includes("--legacy"),
        });
      assert.deepEqual(
        check.failure.oauthRenewal,
        scenario.renewal,
        `${scenario.name} closed renewal evidence`,
      );
      assert.match(check.message, scenario.reason);
      assert.equal(
        (yield* issuer.metrics).refreshes,
        before + 1,
        "Health must actually attempt one token refresh",
      );
      const persisted = (yield* request("GET", `${prefix}/accounts/${account.id}`)).health;
      assertPrivate(persisted);
      assert.deepEqual(
        persisted.apps.find((item) => item.app === app.id)?.check,
        check,
        "Public GET must retain the exact health failure",
      );
      assert.deepEqual(yield* linkSnapshot(), links, "Failed renewal must preserve app links");
      assert.deepEqual(
        yield* accessSnapshot(),
        access,
        "Failed renewal changed ownership or access",
      );
      yield* Effect.promise(() =>
        save(`${scenario.name}-health.json`, {
          accountId: account.id,
          check,
          publicGetMatches: true,
        }),
      );
      // The next interactive sign-in succeeds. The existing recovery flow owns all credential writes.
      yield* issuer.configure({ tokenError: null });
      const ui = yield* proveRecoveryUi({ target, actors, app, label, directory, ...scenario });
      if (scenario.reconnect) {
        assert.equal(ui.accountId, account.id, "Reconnect replaced the existing account ID");
        assert.deepEqual(yield* linkSnapshot(), links, "Reconnect changed the existing app links");
        assert.deepEqual(yield* accessSnapshot(), access, "Reconnect changed ownership or access");
        yield* settleLinks();
        const recovered = yield* request("POST", healthPath);
        assertPrivate(recovered);
        assert.equal(recovered.apps.find((item) => item.app === app.id)?.check?.status, "healthy");
      }
      outcomes.push({
        name: scenario.name,
        passed: true,
        accountId: account.id,
        linksPreserved: true,
        accessPreserved: true,
        ...ui,
      });
      yield* Effect.promise(() => save("outcomes.json", outcomes));
    }
  });
  yield* journey.pipe(
    Effect.scoped,
    Effect.provide(Browser.layer),
    Effect.provide(
      scenarioEvidence({ file: "e2e/oauth-renewal-recovery.mjs", name: "OAuth renewal recovery" }),
    ),
    Effect.provide(Telemetry.layer),
    Effect.provide(RecordingFocus.layer),
    Effect.provide(BrowserDriver.layer),
    Effect.provideService(Target, target),
  );
});

try {
  await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
} catch {
  // Raw errors can include third-party request details. Keep the failing phase and SDK's redacted evidence.
  process.exitCode = 1;
  await save("failure.json", {
    phase,
    message: "Proof failed; inspect retained SDK evidence for this phase.",
  });
} finally {
  await save("report.json", {
    passed: process.exitCode !== 1 && outcomes.length === 3,
    phase,
    outcomes,
    legacyNoReason:
      "Old-record compatibility is independently exercised with the pre-change SDK and current UI in the retained --legacy baseline. The normal run exercises newly recorded failures.",
  });
  console.log(
    JSON.stringify({ directory, phase, passed: process.exitCode !== 1, cases: outcomes.length }),
  );
}
