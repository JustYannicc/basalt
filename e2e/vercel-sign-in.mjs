import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
import { appsVersion, mcpSdkVersion } from "../.upstream/e2e/support/apps-release.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { localOpenapi } from "./openapi-fixture.mjs";
import { startVercelFixture } from "./vercel-fixture.mjs";
import { mcpPayload, proveVercelMcp } from "./vercel-mcp.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/vercel-sign-in", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const sourceBytes = await readFile(join(root, "src/catalog/vercel.json"));
const beforeBytes = await readFile(join(root, "src/catalog/vercel.published.json"));
process.chdir(upstream);
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, actual, expected });
  assert.deepEqual(actual, expected, name);
};
const program = Effect.gen(function* () {
  const fixture = yield* Effect.acquireRelease(Effect.promise(startVercelFixture), (fixture) =>
    Effect.promise(fixture.stop),
  );
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "Vercel sign-in and retained token");
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target: prepared,
      authSecret,
      directory,
      organization: "vercel-sign-in",
      namePrefix: "vercel",
    }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([fixture.rest, new URL(fixture.mcp).origin]),
  });
  const target = Target.of({
    ...prepared,
    controlOrigin: server.controlOrigin,
    metadata: { ...prepared.metadata, origin: server.origin },
  });
  const services = yield* Layer.build(
    SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
  );
  const api = Context.get(services, SessionClients);
  const session = yield* api.session(Redacted.make(actors.owner.cookies));
  const response = (method, path, data) => api.request(session, method, path, data);
  const request = (method, path, data) =>
    response(method, path, data).pipe(
      Effect.map((result) => {
        assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.body)}`);
        return result.body;
      }),
    );
  const prefix = `/api/organizations/${actors.organization.id}`;
  // Only external origins and the fixture's served framework release change.
  const files = async (bytes) => {
    const source = JSON.parse(bytes);
    const localized = await localOpenapi(
      source.files
        .filter((file) => file.path !== "package.json")
        .map((file) => ({
          ...file,
          content: file.content
            .replaceAll("https://mcp.vercel.com/", fixture.mcp)
            .replaceAll(
              'hosts: ["mcp.vercel.com"]',
              `hosts: [${JSON.stringify(new URL(fixture.mcp).host)}]`,
            )
            .replaceAll("https://api.vercel.com", fixture.rest)
            .replaceAll(
              'hosts: ["api.vercel.com"]',
              `hosts: [${JSON.stringify(new URL(fixture.rest).host)}]`,
            ),
        })),
      fixture.rest,
      "vercel",
    );
    localized.document.components = {
      securitySchemes: { bearerToken: { type: "http", scheme: "bearer" } },
    };
    localized.document.security = [{ bearerToken: [] }];
    localized.document.paths["/fixture/write"] = {
      post: {
        operationId: "fixture_write",
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    };
    fixture.documents.set("/openapi/vercel.json", localized.document);
    return [
      ...localized.files,
      {
        path: "package.json",
        content: JSON.stringify({
          dependencies: {
            apps: appsVersion,
            "@modelcontextprotocol/sdk": mcpSdkVersion,
          },
        }),
      },
    ];
  };
  const app = yield* request("POST", `${prefix}/apps/deploy`, {
    name: "Vercel sign-in proof",
    files: yield* Effect.promise(() => files(beforeBytes)),
  });
  const path = `${prefix}/apps/${app.id}`;
  const beforeRequirement = app.requirements.accounts.vercel;
  const connection = yield* request("POST", `${path}/accounts/user/vercel/connections`, {});
  const token = yield* request("POST", `${prefix}/connections/${connection.id}/submit`, {
    method: "apiKey",
    label: "Retained token",
    fields: { token: "synthetic-vercel-rest" },
  });
  const call = (tool, accountId) =>
    request("POST", `${path}/tools/call`, { tool, input: { accountId, input: {} } });
  check("token works before upgrade", yield* call("fixture_read", token.id), {
    transport: "rest",
    marker: "retained-token",
  });
  yield* request("POST", `${path}/deploy`, {
    files: yield* Effect.promise(() => files(sourceBytes)),
  });
  const updated = yield* request("GET", path);
  check(
    "entire token requirement retained",
    updated.requirements.accounts.vercel,
    beforeRequirement,
  );
  check(
    "new sign-in is optional and separate",
    updated.requirements.accounts.signIn.cardinality,
    "many",
  );
  check("token works with no OAuth account", yield* call("fixture_read", token.id), {
    transport: "rest",
    marker: "retained-token",
  });
  const oauthConnection = yield* request("POST", `${path}/accounts/user/signIn/connections`, {});
  const signIn = yield* request("POST", `${prefix}/connections/${oauthConnection.id}/oauth/start`, {
    method: "oauth",
  });
  const consent = yield* Effect.promise(() =>
    fetch(signIn.authorizationUrl, { redirect: "manual" }),
  );
  check("authorization handoff", consent.status, 302);
  const oauth = yield* request(
    "POST",
    `${prefix}/connections/${oauthConnection.id}/oauth/complete`,
    {
      callbackUrl: consent.headers.get("location"),
    },
  );
  check("automatic client registration", fixture.registrations(), 1);
  check("one PKCE exchange", fixture.exchanges(), 1);
  for (const account of [token, oauth]) {
    const health = yield* request("POST", `${prefix}/accounts/${account.id}/health`);
    check(
      `healthy ${account.method}`,
      health.apps.find((entry) => entry.app === app.id)?.check?.status,
      "healthy",
    );
  }
  const tools = yield* request("GET", `${path}/tools/index`);
  for (const name of ["fixture_read", "fixture_write", "read_project", "delete_project"])
    check(
      `discover ${name}`,
      tools.items.some((item) => item.name === name),
      true,
    );
  check("token still works beside OAuth", yield* call("fixture_read", token.id), {
    transport: "rest",
    marker: "retained-token",
  });
  check("OAuth HTTP read", mcpPayload(yield* call("read_project", oauth.id)), {
    transport: "mcp",
    marker: "read_project",
  });
  const wrong = yield* response("POST", `${path}/tools/call`, {
    tool: "read_project",
    input: { accountId: token.id, input: {} },
  });
  check("OAuth tool refuses token account", wrong.status, 422);
  for (const [tool, accountId] of [
    ["fixture_write", token.id],
    ["delete_project", oauth.id],
  ]) {
    const refused = yield* response("POST", `${path}/tools/call`, {
      tool,
      input: { accountId, input: {} },
    });
    check(`${tool} requires approval`, refused.status, 409);
    check(`${tool} retains approval error`, refused.body._tag, "ToolApprovalRequired");
  }
  yield* proveVercelMcp({
    upstream,
    origin: server.origin,
    organization: actors.organization.id,
    slug: app.slug,
    request,
    token: token.id,
    oauth: oauth.id,
    check,
  });
  check(
    "REST never receives OAuth credentials",
    fixture.calls
      .filter((call) => call.transport === "rest")
      .every((call) => call.credential === "rest"),
    true,
  );
  check(
    "MCP only receives its OAuth credentials",
    fixture.calls
      .filter((call) => call.transport === "mcp")
      .every((call) => call.credential === "oauth"),
    true,
  );
  check(
    "destructive MCP call never ran",
    fixture.calls.some((call) => call.tool === "delete_project"),
    false,
  );
  check(
    "REST mutation never ran",
    fixture.calls.some((call) => call.path === "/fixture/write"),
    false,
  );
  yield* Effect.promise(() =>
    writeFile(join(directory, "upstream-calls.json"), JSON.stringify(fixture.calls, null, 2)),
  );
  return {
    results,
    sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    beforeSha256: createHash("sha256").update(beforeBytes).digest("hex"),
    framework: appsVersion,
  };
});
try {
  const report = await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: results.length, directory }));
} catch (error) {
  await writeFile(join(directory, "partial-results.json"), JSON.stringify(results, null, 2));
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Vercel sign-in proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
