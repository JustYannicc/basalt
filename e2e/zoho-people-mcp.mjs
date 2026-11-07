import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Context, Effect, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../.upstream/e2e/support/managed-server.ts";
import { controlRequest } from "../.upstream/e2e/support/server-control.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../.upstream/e2e/support/npm-registry.ts";
import { appsVersion } from "../.upstream/e2e/support/apps-release.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { zohoPeople } from "../src/catalog/zoho-people/index.ts";
import { startZohoPeopleFixture } from "./zoho-people-fixture.mjs";
import { startZohoMcpFixture } from "./zoho-people-mcp-fixture.mjs";
import { proveZohoMcpPrivacy } from "./zoho-people-mcp-privacy.mjs";
import { proveZohoMcpUi } from "./zoho-people-mcp-ui.mjs";
import { installRetainedPeopleConsumer } from "./zoho-people-mcp-legacy.mjs";
import { proveZohoMcpRecovery } from "./zoho-people-mcp-recovery.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/zoho-people-mcp", randomBytes(6).toString("hex")),
);
const red = process.argv.includes("--red");
await mkdir(directory, { recursive: true, mode: 0o700 });
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, actual, expected });
  assert.deepEqual(actual, expected, name);
};
const source = zohoPeople.source;
const scopes = JSON.parse(source.files.find((file) => file.path === "scopes.json").content);
const program = Effect.gen(function* () {
  const certificate = join(directory, "fixture-cert.pem");
  const key = join(directory, "fixture-key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const tls = {
    key: yield* Effect.promise(() => readFile(key, "utf8")),
    cert: yield* Effect.promise(() => readFile(certificate, "utf8")),
  };
  const fixture = yield* Effect.acquireRelease(
    Effect.promise(() => startZohoMcpFixture(tls)),
    (value) => Effect.promise(value.stop),
  );
  const other = yield* Effect.acquireRelease(
    Effect.promise(() => startZohoMcpFixture(tls)),
    (value) => Effect.promise(value.stop),
  );
  const rest = yield* Effect.acquireRelease(
    Effect.promise(() => startZohoPeopleFixture(scopes)),
    (value) => Effect.promise(value.stop),
  );
  const files = source.files.map((file) => {
    let content = file.content;
    for (const [id, api, accounts] of [
      ["eu", "https://people.zoho.eu", "https://accounts.zoho.eu"],
      ["us", "https://people.zoho.com", "https://accounts.zoho.com"],
      ["in", "https://people.zoho.in", "https://accounts.zoho.in"],
    ])
      content = content
        .replaceAll(api, rest.regions[id].api)
        .replaceAll(accounts, rest.regions[id].accounts);
    if (file.path === "provider.ts")
      content = content.replace(
        '["mcp.zoho.eu", "mcp.zoho.com", "mcp.zoho.in"]',
        JSON.stringify([new URL(fixture.origin).host, new URL(other.origin).host]),
      );
    if (file.path === "package.json")
      content = JSON.stringify({
        ...JSON.parse(content),
        dependencies: { ...JSON.parse(content).dependencies, apps: appsVersion },
      });
    if (red && file.path === "index.ts") {
      assert.ok(
        content.includes("toolAnnotations(tool)?.readOnlyHint === true ? undefined : always()"),
      );
      content = content.replace(
        "toolAnnotations(tool)?.readOnlyHint === true ? undefined : always()",
        "undefined",
      );
    }
    return { ...file, content };
  });
  const carry = yield* Effect.promise(() =>
    readFile(join(root, "patches/0418-account-owned-mcp-endpoints.patch")),
  );
  yield* Effect.promise(() =>
    writeFile(
      join(directory, "candidate.json"),
      JSON.stringify(
        {
          head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
          framework: appsVersion,
          sourceSha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
          localizedSourceSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
          carrySha256: createHash("sha256").update(carry).digest("hex"),
          injectedDefect: red ? "MCP write approval removed" : null,
        },
        null,
        2,
      ),
    ),
  );
  fixture.setCatalog({ entry: zohoPeople.entry, source: { ...source, files } });
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "Zoho People private MCP endpoint");
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target: prepared,
      authSecret,
      directory,
      organization: "zoho-mcp-proof",
      namePrefix: "zoho-mcp",
    }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_PRODUCT_NAME: "Basalt",
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_CATALOG_URL: `${fixture.origin}/catalog/index.json`,
    NODE_EXTRA_CA_CERTS: certificate,
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([
      fixture.origin,
      other.origin,
      ...Object.values(rest.regions).flatMap((region) => [region.accounts, region.api]),
    ]),
  });
  yield* Effect.promise(() =>
    writeFile(
      join(directory, "runtime.json"),
      JSON.stringify(
        {
          directory: prepared.directory,
          productDirectory: server.directory,
          framework: appsVersion,
        },
        null,
        2,
      ),
    ),
  );
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
  const member = yield* api.session(Redacted.make(actors.member.cookies));
  const observed = [];
  const response = (method, path, data, who = session) =>
    api
      .request(who, method, path, data)
      .pipe(Effect.tap((value) => Effect.sync(() => observed.push(value.body))));
  const request = (method, path, data) =>
    response(method, path, data).pipe(
      Effect.map((value) => {
        assert.ok(
          value.status === 200 || value.status === 204,
          `${method} ${path}, HTTP ${value.status}: ${JSON.stringify(value.body)}`,
        );
        return value.body;
      }),
    );
  const prefix = `/api/organizations/${actors.organization.id}`;
  const catalog = yield* request("GET", "/api/catalog");
  check(
    "fixture catalog lists Zoho People",
    catalog.some((entry) => entry.id === "zoho-people"),
    true,
  );
  const legacy = yield* installRetainedPeopleConsumer({ Effect, files, request, prefix, check });
  fixture.setCatalog({ entry: zohoPeople.entry, source: { ...source, files: legacy.files } });
  const installed = yield* request("POST", `${prefix}/apps/install`, {
    entry: "zoho-people",
    name: "Zoho People MCP proof",
  });
  let app = installed;
  check(
    "REST installation shares the retained consumer provider",
    app.requirements.accounts.people.provider,
    legacy.app.requirements.accounts.people.provider,
  );
  const path = `${prefix}/apps/${app.id}`;
  const connect = (method, endpoint) =>
    Effect.gen(function* () {
      const connection = yield* request("POST", `${path}/accounts/user/people/connections`, {});
      if (endpoint !== undefined)
        yield* request("POST", `${prefix}/connections/${connection.id}/mcp-endpoint`, {
          method,
          endpoint,
        });
      const started = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
        method,
        ...(method === "mcp"
          ? {}
          : {
              client: {
                clientId: "synthetic-people-client",
                clientSecret: "synthetic-people-secret",
              },
            }),
      });
      const callbackUrl =
        method === "mcp"
          ? yield* Effect.promise(() =>
              (endpoint === other.endpoint ? other : fixture).approve(started.authorizationUrl),
            )
          : yield* Effect.promise(async () =>
              (await fetch(started.authorizationUrl, { redirect: "manual" })).headers.get(
                "location",
              ),
            );
      return yield* request("POST", `${prefix}/connections/${connection.id}/oauth/complete`, {
        callbackUrl,
      });
    });
  const restAccount = yield* connect("oauthEu");
  yield* legacy.prove(restAccount);
  fixture.setCatalog({ entry: zohoPeople.entry, source: { ...source, files } });
  const upgraded = yield* request("POST", `${path}/deploy`, { files });
  app = upgraded.app;
  check(
    "MCP method addition retains the earlier REST provider",
    app.requirements.accounts.people.provider,
    installed.requirements.accounts.people.provider,
  );
  const selected = yield* request("GET", `${path}/accounts/user`);
  check(
    "MCP upgrade keeps the selected REST account",
    selected.some((link) => link.account.id === restAccount.id),
    true,
  );
  const restIndex = yield* request("GET", `${path}/tools/index`);
  check("REST tools remain usable with MCP disabled", restIndex.items.length, 184);
  const invoke = (tool, account, input = {}) => ({ tool, input: { accountId: account.id, input } });
  const call = (tool, account, input) =>
    request("POST", `${path}/tools/call`, invoke(tool, account, input));
  check(
    "existing REST read keeps its name",
    (yield* call("timeTracker.listTimeLogs", restAccount, { query: { user: "employee-fixture" } }))
      .response.result,
    [],
  );
  const pending = yield* request("POST", `${path}/accounts/user/people/connections`, {});
  const endpointPath = `${prefix}/connections/${pending.id}/mcp-endpoint`;
  check(
    "foreign connection input refused",
    (yield* response("POST", endpointPath, { method: "mcp", endpoint: fixture.endpoint }, member))
      .status >= 400,
    true,
  );
  const beforeRejected = [fixture, other].map(({ counts }) => [
    counts.requests,
    counts.connections,
  ]);
  for (const endpoint of [
    fixture.endpoint.replace("https:", "http:"),
    fixture.endpoint.replace("127.0.0.1", "localhost"),
    "https://unlisted.invalid/mcp",
  ]) {
    check(
      "invalid endpoint refused",
      (yield* response("POST", endpointPath, { method: "mcp", endpoint })).status >= 400,
      true,
    );
  }
  check(
    "unconfigured endpoint cannot start discovery",
    (yield* response("POST", `${prefix}/connections/${pending.id}/oauth/start`, { method: "mcp" }))
      .status >= 400,
    true,
  );
  check(
    "invalid endpoint rejection makes no network connection or request",
    [fixture, other].map(({ counts }) => [counts.requests, counts.connections]),
    beforeRejected,
  );
  yield* request("POST", endpointPath, { method: "mcp", endpoint: fixture.endpoint });
  const configured = yield* request("GET", `${prefix}/connections/${pending.id}`);
  check("public connection reports configuration only", configured.mcpEndpointMethod, "mcp");
  yield* request("POST", `${prefix}/connections/${pending.id}/cancel`, {});
  check(
    "cancelled binding cannot start OAuth",
    (yield* response("POST", `${prefix}/connections/${pending.id}/oauth/start`, { method: "mcp" }))
      .status >= 400,
    true,
  );
  const account = yield* connect("mcp", fixture.endpoint);
  check("private endpoint uses DCR", fixture.counts.registrations > 0, true);
  check("private endpoint exchanges OAuth code", fixture.counts.exchanges, 1);
  const health = yield* request("POST", `${prefix}/accounts/${account.id}/health`);
  yield* Effect.promise(() =>
    writeFile(join(directory, "health.json"), JSON.stringify(health, null, 2)),
  );
  check(
    "MCP account is checked with and without credentials",
    health.apps.find((entry) => entry.app === app.id)?.check?.status,
    "healthy",
  );
  check("health refuses anonymous access", fixture.counts.anonymous > 0, true);
  const index = yield* request("GET", `${path}/tools/index`);
  for (const name of ["mcp.readPeople", "mcp.updatePeople", "mcp.unknownPeople"])
    check(
      `discovers configured ${name}`,
      index.items.some((tool) => tool.name === name),
      true,
    );
  yield* call("mcp.readPeople", account);
  check("read-only MCP call executes", fixture.calls.at(-1), "readPeople");
  for (const tool of ["mcp.updatePeople", "mcp.unknownPeople"]) {
    const invocation = invoke(tool, account);
    check(
      `${tool} direct call requires approval`,
      (yield* response("POST", `${path}/tools/call`, invocation)).status,
      409,
    );
    const before = fixture.calls.length;
    const cancelled = yield* request("POST", `${path}/tools/run`, invocation);
    check(`${tool} asks approval`, cancelled.status, "approval-required");
    yield* request("POST", `${path}/tools/approvals/${cancelled.requestId}`, {
      response: { action: "cancel", content: {} },
    });
    check(`${tool} cancellation has no effect`, fixture.calls.length, before);
    const approved = yield* request("POST", `${path}/tools/run`, invocation);
    const completed = yield* request("POST", `${path}/tools/approvals/${approved.requestId}`, {
      response: { action: "accept", content: {} },
    });
    check(`${tool} approved call completes`, completed.result.status, "completed");
  }
  const beforeHidden = fixture.calls.length;
  check(
    "hidden MCP tool direct call refused",
    (yield* response("POST", `${path}/tools/call`, invoke("mcp.hiddenPeople", account))).status >=
      400,
    true,
  );
  check("hidden MCP tool never reaches server", fixture.calls.length, beforeHidden);
  const second = yield* connect("mcp", other.endpoint);
  const firstCalls = fixture.calls.length;
  yield* call("mcp.readPeople", second);
  check("second account uses its own exact endpoint", other.calls.at(-1), "readPeople");
  check("second account never uses first endpoint", fixture.calls.length, firstCalls);
  yield* call("mcp.readPeople", account);
  check("first account retains its endpoint", fixture.calls.length, firstCalls + 1);
  check("saved MCP grant refreshes", fixture.counts.refreshes > 0, true);
  yield* proveZohoMcpRecovery({
    Effect,
    fixture,
    path,
    prefix,
    account,
    restAccount,
    request,
    response,
    call,
    check,
  });
  yield* legacy.prove(restAccount);
  yield* call("timeTracker.listTimeLogs", restAccount, { query: { user: "employee-fixture" } });
  if (!red) {
    yield* controlRequest("stop", 200).pipe(Effect.provideService(Target, target));
    yield* controlRequest("environment", 200, {
      EXECUTOR_OAUTH_CALLBACK_URL: new URL("/oauth/callback", target.metadata.origin).href,
    }).pipe(Effect.provideService(Target, target));
    yield* controlRequest("start", 200).pipe(Effect.provideService(Target, target));
    yield* proveZohoMcpUi({
      Effect,
      target,
      actors,
      app,
      fixture,
      tls,
      directory,
      check,
    });
  }
  yield* proveZohoMcpPrivacy({
    api,
    session,
    target,
    path,
    prefix,
    account,
    endpoint: fixture.endpoint,
    request,
    response,
    directory,
    check,
  });
  const accounts = yield* request("GET", `${prefix}/inventory`);
  const appRecord = yield* request("GET", path);
  const safe = JSON.stringify({
    accounts,
    appRecord,
    configured,
    index,
    health,
    responses: observed.filter(
      (value) => !(typeof value === "object" && value !== null && "authorizationUrl" in value),
    ),
  });
  for (const marker of ["synthetic-people-endpoint-marker", "synthetic-private-query-marker"])
    check("private endpoint absent from public metadata", safe.includes(marker), false);
  const logs = yield* Effect.promise(() =>
    readFile(join(server.directory ?? prepared.directory, "server.log"), "utf8"),
  );
  for (const marker of ["synthetic-people-endpoint-marker", "synthetic-private-query-marker"])
    check("private endpoint absent from product logs", logs.includes(marker), false);
  return {
    red,
    framework: appsVersion,
    checks: results,
    fixture: { ...fixture.counts, calls: fixture.calls },
    other: { ...other.counts, calls: other.calls },
  };
});
process.chdir(upstream);
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
  console.error("Zoho MCP proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
