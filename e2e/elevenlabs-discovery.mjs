import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
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
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { currentDocument, expectedTools, packageBytes } from "../scripts/upstream-tests/fixtures/elevenlabs.ts";
import { onServedFramework } from "../src/catalog/framework.ts";

/**
 * The official ElevenLabs catalog package, as Basalt's catalog serves it, serves its tools to an
 * account's discovery while its definition lacks routes two of its patches target. The catalog
 * serves it on the framework Basalt ships; on a framework without carry 0166 that discovery fails
 * with "SchemaError: Expected object".
 */
const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(process.argv[2] ?? join(root, ".generated/elevenlabs-discovery", randomBytes(6).toString("hex")));
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(upstream);

const key = "synthetic-elevenlabs-key";
const calls = [];
let document;
const fixture = createServer((request, response) => {
  calls.push({ path: request.url, key: request.headers["xi-api-key"] ?? null });
  const json = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/openapi.json") return json(200, document);
  if (request.url === "/v1/user")
    return request.headers["xi-api-key"] === key ? json(200, { user_id: "fixture-user" }) : json(401, {});
  json(404, {});
});
await new Promise((ready) => fixture.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${fixture.address().port}`;
document = currentDocument(origin);

const program = Effect.gen(function* () {
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "ElevenLabs discovery with dropped routes");
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({ executable: process.execPath, upstream, target: prepared, authSecret, directory }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([origin]),
  });
  const target = Target.of({
    ...prepared,
    controlOrigin: server.controlOrigin,
    metadata: { ...prepared.metadata, origin: server.origin },
  });
  const services = yield* Layer.build(SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))));
  const api = Context.get(services, SessionClients);
  const session = yield* api.session(Redacted.make(actors.owner.cookies));
  const request = (method, path, data) =>
    Effect.map(api.request(session, method, path, data), (response) => {
      assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
      return response.body;
    });
  const prefix = `/api/organizations/${actors.organization.id}`;
  // The package as the catalog serves it; only the provider's origin changes, so its own patches
  // meet the fixture definition.
  const files = JSON.parse(onServedFramework(packageBytes.toString())).files
    .map((file) => ({
      ...file,
      content: file.content
        .replaceAll("https://api.elevenlabs.io", origin)
        .replaceAll('hosts: ["api.elevenlabs.io"]', `hosts: [${JSON.stringify(new URL(origin).host)}]`),
    }));
  const app = yield* request("POST", `${prefix}/apps/deploy`, { name: "ElevenLabs discovery proof", files });
  const appPath = `${prefix}/apps/${app.id}`;
  const connection = yield* request("POST", `${appPath}/accounts/user/elevenlabs/connections`, {});
  const account = yield* request("POST", `${prefix}/connections/${connection.id}/submit`, {
    method: "apiKey",
    label: "Synthetic ElevenLabs",
    fields: { token: key },
  });
  const health = yield* request("POST", `${prefix}/accounts/${account.id}/health`);
  // The tool catalog the dashboard and agents' discovery read for this account.
  const catalog = yield* request("GET", `${appPath}/tools`);
  return {
    health: health.apps.find((entry) => entry.app === app.id)?.check?.status,
    routerErrors: catalog.routers.filter((router) => router.error !== undefined),
    tools: catalog.items.length,
  };
});

try {
  const result = await Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );
  await writeFile(join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  assert.equal(result.health, "healthy");
  assert.deepEqual(result.routerErrors, []);
  assert.equal(result.tools, expectedTools(document));
  // The account's key reached the fixture, and nothing went to the dropped routes.
  assert.ok(calls.some((call) => call.path === "/v1/user" && call.key === key));
  assert.ok(calls.every((call) => !call.path.startsWith("/v1/speech-to-speech")));
  console.log(JSON.stringify({ tools: result.tools, health: result.health, directory }));
} catch (error) {
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("ElevenLabs discovery proof failed; private diagnostics retained.");
  process.exitCode = 1;
} finally {
  fixture.close();
}
