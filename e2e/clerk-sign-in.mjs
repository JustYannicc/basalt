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
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { verifyLocalGuidance } from "./clerk-signin/local-guidance.mjs";
import { startClerkCatalog } from "./clerk-signin/catalog.mjs";
import { retainClerkKey } from "./clerk-signin/retained-key.mjs";

import { clerkJourney } from "./clerk-signin/journey.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const phase = process.argv[3] ?? "signin";
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/clerk-sign-in", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(upstream);
const outcomes = [];
const program = Effect.gen(function* () {
  const fixture = yield* Effect.acquireRelease(Effect.promise(startClerkCatalog), (fixture) =>
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
  const prepared = yield* prepareScenario(base.target, "Clerk connection guidance");
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
      organization: "clerk-sign-in",
      namePrefix: "clerk",
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
    entry: "clerk",
    name: "Clerk",
  });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const app = installed.body;
  const retained =
    phase === "signin" ? yield* retainClerkKey({ fixture, request, prefix, app }) : undefined;
  for (const width of [1280, 390]) {
    const result = yield* Effect.exit(
      clerkJourney({
        width,
        request,
        phase,
        session,
        target,
        server,
        api,
        prefix,
        app,
        retained,
        fixture,
        actors,
      }),
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
  console.error("Clerk sign-in proof failed; private evidence retained.");
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
