import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readPatchManifest } from "../releases/patches.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigProvider, Context, Effect, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { firstPartyOAuthClients } from "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../../.upstream/e2e/support/managed-server.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { freePort } from "../../.upstream/e2e/support/ports.ts";
import { provisionSelfHostActors } from "./test-accounts.mjs";
import { startZendeskFixtures } from "./zendesk-fixture.mjs";
import { startZendeskCatalogWorker } from "./zendesk-catalog.mjs";
import { proveTenantPublic } from "./zendesk-tenant-public.mjs";
import { proveOperatorChoices } from "./zendesk-operator-choices.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstream = join(root, ".upstream");
await mkdir(join(root, ".generated/connectors-proof"), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, ".generated/connectors-proof/zendesk-tenant-"));
await writeFile(
  join(directory, "proof-input.json"),
  JSON.stringify(
    {
      candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      upstream: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: upstream,
        encoding: "utf8",
      }).trim(),
      patches: readPatchManifest(root).patches.map(({ file, content_sha256 }) => ({
        file,
        content_sha256,
      })),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.chdir(upstream);
let phase = "initialization";
const step = (value) => {
  phase = value;
  console.log(`Zendesk tenant proof: ${value}`);
};
const checked = (response, status, operation) => {
  assert.equal(
    response.status,
    status,
    `${operation}: ${response.body?._tag ?? "unexpected response"}`,
  );
  return response.body;
};
const callback = "https://client.example.test/oauth/callback";
const exactReplace = (text, before, after) => {
  assert.equal(text.split(before).length - 1, 1, "Only declared test endpoints may change");
  return text.replace(before, after);
};
const program = Effect.gen(function* () {
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  for (const global of [false, true]) {
    step(global ? "global-client-preference" : "tenant-public-client");
    const fixtures = yield* Effect.acquireRelease(
      Effect.promise(() => startZendeskFixtures({ tenantPublicClients: true, expiresIn: 0 })),
      (fixtures) => Effect.promise(() => fixtures.stop()),
    );
    const catalog = yield* Effect.acquireRelease(
      Effect.promise(() => startZendeskCatalogWorker({ root, upstream, directory })),
      (catalog) => Effect.promise(() => catalog.stop()),
    );
    const source = yield* Effect.promise(async () => {
      const response = await fetch(`${catalog.origin}/catalog/apps/zendesk.json`);
      assert.equal(response.status, 200);
      const result = await response.json();
      const config = result.files.find((file) => file.path === "configuration.ts").content;
      assert.match(config, /= \{\};/u, "Publisher metadata must be optional");
      const index = result.files.find((file) => file.path === "index.ts");
      index.content = exactReplace(
        index.content,
        'const declarationOrigin = "https://example.zendesk.com";',
        `const declarationOrigin = ${JSON.stringify(fixtures.sites[0].origin)};`,
      );
      index.content = exactReplace(
        index.content,
        'hosts: ["example.zendesk.com"]',
        `hosts: ${JSON.stringify([fixtures.sites[0].host])}`,
      );
      index.content = exactReplace(
        index.content,
        'subdomainOf: "zendesk.com"',
        'subdomainOf: "localhost"',
      );
      assert.ok(index.content.includes('const scopes = ["read", "write"]'));
      return result;
    });
    const settings = global
      ? {
          EXECUTOR_OAUTH_ZENDESK_CLIENT_ID: "zendesk-fixture-client",
          EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET: "zendesk-fixture-secret",
        }
      : {};
    const productionClients = yield* firstPartyOAuthClients({ testDefinitions: false }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(settings)),
    );
    assert.deepEqual(
      productionClients.map((value) => value.id),
      global
        ? ["zendesk", "zendesk-tenant", "zendesk-tenant-paste"]
        : ["zendesk-tenant", "zendesk-tenant-paste"],
    );
    const environment = {};
    const definitions = productionClients.map((client) => {
      const { clientId, clientSecret, ...definition } = client;
      const id = `${client.id}-proof`;
      const prefix = `EXECUTOR_OAUTH_${id.toUpperCase().replaceAll("-", "_")}`;
      environment[`${prefix}_CLIENT_ID`] = clientId;
      if (clientSecret !== undefined)
        environment[`${prefix}_CLIENT_SECRET`] = Redacted.value(clientSecret);
      return {
        ...definition,
        id,
        label: client.id === "zendesk" ? "Synthetic global Zendesk" : client.label,
        issuerSite: { ...client.issuerSite, subdomainOf: "localhost" },
        server: {
          ...client.server,
          authorizationUrl: `${fixtures.sites[0].origin}/oauth/authorizations/new`,
          tokenUrl: `${fixtures.sites[0].origin}/oauth/tokens`,
        },
        placement: { ...client.placement, hosts: [fixtures.sites[0].host] },
      };
    });
    const prepared = yield* prepareScenario(
      base.target,
      `Zendesk tenant PKCE ${global ? "global" : "fallback"}`,
    );
    const port = yield* freePort;
    const authSecret = randomBytes(32).toString("hex");
    const targetInput = Target.of({
      ...prepared,
      metadata: { ...prepared.metadata, origin: `http://127.0.0.1:${port}` },
    });
    const caseDirectory = join(directory, global ? "global" : "tenant");
    yield* Effect.promise(() => mkdir(caseDirectory, { recursive: true, mode: 0o700 }));
    const cliActors = yield* Effect.promise(() =>
      provisionSelfHostActors({
        executable: process.execPath,
        upstream,
        target: targetInput,
        authSecret,
        directory: caseDirectory,
        organization: global ? "zendesk-global" : "zendesk-tenant",
      }),
    );
    const server = yield* startManagedServer(targetInput, "product", {
      ...environment,
      BETTER_AUTH_SECRET: authSecret,
      EXECUTOR_NPM_REGISTRY: registry.url,
      EXECUTOR_OAUTH_CALLBACK_URL: callback,
      EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify(definitions),
      EXECUTOR_OAUTH_ZENDESK_CLIENT_ID: "",
      EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET: "",
      EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
      EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify(fixtures.sites.map((site) => site.origin)),
    });
    const target = Target.of({
      ...targetInput,
      controlOrigin: server.controlOrigin,
      metadata: { ...targetInput.metadata, origin: server.origin },
    });
    const services = yield* Layer.build(
      SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
    );
    const sessions = Context.get(services, SessionClients);
    const actors = {
      organization: cliActors.organization,
      owner: yield* sessions.session(Redacted.make(cliActors.owner.cookies)),
      member: yield* sessions.session(Redacted.make(cliActors.member.cookies)),
    };
    const request = (actor, method, path, data) => sessions.request(actor, method, path, data);
    const prefix = `/api/organizations/${actors.organization.id}`;
    const app = checked(
      yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: "Zendesk tenant proof",
        files: source.files,
      }),
      200,
      "Deploy the catalog's Zendesk app",
    );
    app.path = `${prefix}/apps/${app.id}`;
    const access = checked(
      yield* request(actors.owner, "GET", `${app.path}/access`),
      200,
      "Read app access",
    );
    checked(
      yield* request(actors.owner, "PATCH", `${app.path}/access`, {
        revision: access.revision,
        audience: { kind: "everyone" },
      }),
      200,
      "Share the synthetic app",
    );
    const result = yield* proveTenantPublic({
      Effect,
      request,
      checked,
      actors,
      prefix,
      app,
      callback,
      fixtures,
      global,
    });
    const choices = yield* proveOperatorChoices({
      Effect,
      request,
      checked,
      actors,
      prefix,
      app,
      callback,
      fixtures,
      global,
      advanceClock: (milliseconds) =>
        Effect.promise(async () => {
          const response = await fetch(`${server.controlOrigin}/clock/advance`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ milliseconds }),
          });
          assert.equal(
            response.status,
            200,
            "The isolated product clock must advance before checking expiry",
          );
        }),
    });
    yield* Effect.promise(() =>
      writeFile(
        join(directory, global ? "global.json" : "tenant.json"),
        JSON.stringify({ ...result, choices }, null, 2),
        { mode: 0o600 },
      ),
    );
  }
});
try {
  await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  console.log(
    "Zendesk tenant proof passed: method order, callback paste, state/redirect/expiry/replay refusal, per-user PKCE, refresh and revocation.",
  );
} catch (error) {
  await writeFile(
    join(directory, "failure.txt"),
    error instanceof Error ? error.stack : String(error),
    { mode: 0o600 },
  );
  console.error(`Zendesk tenant proof failed during ${phase}; private evidence retained.`);
  process.exitCode = 1;
}
