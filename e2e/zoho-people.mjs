import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
import { appsVersion } from "../.upstream/e2e/support/apps-release.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { handleCatalog } from "../src/catalog/worker.ts";
import { catalog } from "../src/catalog/settings.ts";
import { startZohoPeopleFixture } from "./zoho-people-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/zoho-people", randomBytes(6).toString("hex")),
);
const red = process.argv.includes("--red");
await mkdir(directory, { recursive: true, mode: 0o700 });
const published = await handleCatalog(
  new Request(`https://routes-fixture.invalid${catalog.path}apps/zoho-people.json`),
  async () => {
    throw new Error("Zoho People must be served without its publisher");
  },
);
assert.equal(published.status, 200);
const bytes = Buffer.from(await published.text());
const source = JSON.parse(bytes);
const definitions = JSON.parse(
  source.files.find((file) => file.path === "operations.json").content,
);
const scopes = JSON.parse(source.files.find((file) => file.path === "scopes.json").content);
process.chdir(upstream);
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, actual, expected });
  assert.deepEqual(actual, expected, name);
};
const program = Effect.gen(function* () {
  const fixture = yield* Effect.acquireRelease(
    Effect.promise(() => startZohoPeopleFixture(scopes)),
    (fixture) => Effect.promise(fixture.stop),
  );
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "Zoho People connection and tools");
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target: prepared,
      authSecret,
      directory,
      organization: "zoho-people-proof",
      namePrefix: "zoho-people",
    }),
  );
  const eu = fixture.regions.eu;
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify(
      Object.values(fixture.regions).flatMap((region) => [region.accounts, region.api]),
    ),
    EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([
      {
        id: "zoho-people-fixture",
        label: "Zoho People fixture",
        server: {
          authorizationUrl: `${eu.accounts}/oauth/v2/auth`,
          tokenUrl: `${eu.accounts}/oauth/v2/token`,
          revocationUrl: `${eu.accounts}/oauth/v2/token/revoke`,
          scopeSeparator: ",",
          grantedScopeSeparator: ",",
          authorizationParams: { access_type: "offline", prompt: "consent" },
        },
        tokenEndpointAuthMethod: "client_secret_post",
        defaultScopes: scopes,
        placement: { hosts: [new URL(eu.api).host], scheme: "Zoho-oauthtoken" },
      },
    ]),
    EXECUTOR_OAUTH_ZOHO_PEOPLE_FIXTURE_CLIENT_ID: "synthetic-people-client",
    EXECUTOR_OAUTH_ZOHO_PEOPLE_FIXTURE_CLIENT_SECRET: "synthetic-people-secret",
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
  const files = source.files
    .filter((file) => file.path !== "package.json")
    .map((file) => {
      let content = file.content;
      for (const [id, api, accounts] of [
        ["eu", "https://people.zoho.eu", "https://accounts.zoho.eu"],
        ["us", "https://people.zoho.com", "https://accounts.zoho.com"],
        ["in", "https://people.zoho.in", "https://accounts.zoho.in"],
      ]) {
        content = content
          .replaceAll(api, fixture.regions[id].api)
          .replaceAll(accounts, fixture.regions[id].accounts);
      }
      if (red && file.path === "index.ts") {
        assert.equal(content.split("approval: always()").length, 2);
        content = content.replace("approval: always()", "approval: undefined");
      }
      return { ...file, content };
    });
  files.push({
    path: "package.json",
    content: JSON.stringify({ dependencies: { apps: appsVersion } }),
  });
  yield* Effect.promise(() =>
    writeFile(
      join(directory, "candidate.json"),
      JSON.stringify(
        {
          sourceSha256: createHash("sha256").update(bytes).digest("hex"),
          localizedSourceSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
          injectedDefect: red ? "mutation approval removed" : null,
        },
        null,
        2,
      ),
    ),
  );
  const app = yield* request("POST", `${prefix}/apps/deploy`, { name: "Zoho People proof", files });
  const path = `${prefix}/apps/${app.id}`;
  const provider = app.requirements.accounts.people.provider;
  const connect = (method, client) =>
    Effect.gen(function* () {
      const connection = yield* request("POST", `${path}/accounts/user/people/connections`, {});
      const start = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
        method,
        ...(client ? { client } : {}),
      });
      const consent = yield* Effect.promise(() =>
        fetch(start.authorizationUrl, { redirect: "manual" }),
      );
      check(`${method} authorization`, consent.status, 302);
      return yield* request("POST", `${prefix}/connections/${connection.id}/oauth/complete`, {
        callbackUrl: consent.headers.get("location"),
      });
    });
  const setup = yield* request("GET", `${prefix}/providers/${provider}/oauth/oauthEu/setup`);
  check("EU offers hosted client", setup.firstParty?.label === "Zoho People fixture", true);
  const account = yield* connect("oauthEu");
  check("EU exchange", eu.exchanges(), 1);
  const health = yield* request("POST", `${prefix}/accounts/${account.id}/health`);
  yield* Effect.promise(() =>
    writeFile(
      join(directory, "health-diagnostics.json"),
      JSON.stringify({ health, calls: fixture.calls }, null, 2),
    ),
  );
  check(
    "account health",
    health.apps.find((entry) => entry.app === app.id)?.check?.status,
    "healthy",
  );
  const index = yield* request("GET", `${path}/tools/index`);
  check(
    "all documented core tools are discoverable",
    index.items.map((item) => item.name).sort(),
    definitions.map((definition) => `${definition.area}.${definition.name}`).sort(),
  );
  const call = (tool, input = {}, selected = account) => ({
    tool,
    input: { accountId: selected.id, input },
  });
  const read = (tool, input, selected) =>
    request("POST", `${path}/tools/call`, call(tool, input, selected));
  check(
    "initial time logs",
    (yield* read("timeTracker.listTimeLogs", { query: { user: "employee-fixture" } })).response
      .result,
    [],
  );
  const add = call("timeTracker.addTimeLog", {
    query: {
      user: "employee-fixture",
      jobId: "job-fixture",
      workDate: "07-Nov-2026",
      workItem: "approved proof",
      hours: "01:00",
    },
  });
  const refused = yield* response("POST", `${path}/tools/call`, add);
  check("unapproved write is blocked", refused.status, 409);
  check(
    "blocked write never reached Zoho",
    fixture.calls.some((call) => call.path.endsWith("/addtimelog")),
    false,
  );
  const approve = (invocation, action = "accept") =>
    Effect.gen(function* () {
      const pending = yield* request("POST", `${path}/tools/run`, invocation);
      check(`${invocation.tool} asks approval`, pending.status, "approval-required");
      return yield* request("POST", `${path}/tools/approvals/${pending.requestId}`, {
        response: { action, content: {} },
      });
    });
  const written = yield* approve(add);
  check("approved write completes", written.result.status, "completed");
  check(
    "approved write readback",
    (yield* read("timeTracker.listTimeLogs", { query: { user: "employee-fixture" } })).response
      .result,
    [{ id: "1", workItem: "approved proof" }],
  );
  yield* approve(add, "cancel");
  check(
    "cancelled write never executes",
    fixture.calls.filter((call) => call.path.endsWith("/addtimelog")).length,
    1,
  );
  const unbounded = yield* response(
    "POST",
    `${path}/tools/call`,
    call("attendance.deleteEntriesForDay", {}),
  );
  check("day deletion requires employee and date", unbounded.status, 422);
  check(
    "invalid day deletion never reaches Zoho",
    fixture.calls.some((entry) => entry.method === "DELETE"),
    false,
  );
  yield* approve(
    call("attendance.deleteEntriesForDay", {
      query: { employee_zoho_id: "employee-fixture", date: "07-Nov-2026" },
    }),
  );
  const failed = yield* response(
    "POST",
    `${path}/tools/call`,
    call("timeTracker.listTimeLogs", { query: { user: "vendor-error" } }),
  );
  check("HTTP 200 vendor failure is not successful", failed.status >= 400, true);
  check(
    "vendor failure is not retried",
    fixture.calls.filter((call) => call.query.user === "vendor-error").length,
    1,
  );
  yield* read("leaveTracker.getLeaveRequests", {
    query: { from_date: "2026-11-01", to_date: "2026-11-07", leave_type_ids: ["leave-fixture"] },
  });
  yield* approve(
    call("leaveTracker.cancelLeaveRequestV2", {
      path: { record_id: "leave-fixture" },
      query: { reason: "Rescheduling fixture leave" },
    }),
  );
  yield* approve(
    call("formsData.insertFormRecord", {
      path: { formLinkName: "fixture" },
      body: { inputData: { label: "value" } },
    }),
  );
  check(
    "generic form JSON input and readback",
    (yield* read("formsData.getFormRecords", { path: { formLinkName: "fixture" } })).response
      .result,
    [{ label: "value" }],
  );
  yield* approve(
    call("attendance.recordAttendancePunch", {
      body: {
        empId: "employee-fixture",
        checkIn: "07-11-2026 09:00:00",
        dateFormat: "dd-MM-yyyy HH:mm:ss",
      },
    }),
  );
  const permission = call("attendance.applyPermission", {
    query: { input: JSON.stringify({ erecno: "employee-fixture", date: "07/11/2026" }) },
  });
  check(
    "GET mutation also requires approval",
    (yield* response("POST", `${path}/tools/call`, permission)).status,
    409,
  );
  yield* approve(permission);
  yield* approve(
    call("attendance.uploadSupportingDocument", {
      files: {
        file: {
          filename: "proof.txt",
          dataBase64: Buffer.from("fixture upload").toString("base64"),
          contentType: "text/plain",
        },
      },
    }),
  );
  check(
    "binary download",
    (yield* read("timeTracker.downloadAttachment", {
      query: { entity: "timelog", recordId: "log-fixture", attachmentId: "attachment-fixture" },
    })).dataBase64,
    Buffer.from("fixture download").toString("base64"),
  );
  check("short-lived token refreshes through its regional issuer", eu.refreshes() > 0, true);
  const byo = { clientId: "synthetic-people-client", clientSecret: "synthetic-people-secret" };
  for (const [method, id] of [
    ["oauthUs", "us"],
    ["oauthIn", "in"],
  ]) {
    const account = yield* connect(method, byo);
    yield* read("timeTracker.listTimeLogs", { query: { user: "employee-fixture" } }, account);
    check(`${method} uses its own API`, fixture.calls.at(-1).region, id);
    check(`${method} refresh uses its own issuer`, fixture.regions[id].refreshes() > 0, true);
  }
  const explicit = yield* connect("oauthIn", byo);
  yield* read("timeTracker.listTimeLogs", { query: { user: "employee-fixture" } }, explicit);
  check("token domain cannot override selected region", fixture.calls.at(-1).region, "in");
  yield* Effect.promise(() =>
    writeFile(join(directory, "fixture-calls.json"), JSON.stringify(fixture.calls, null, 2)),
  );
  return {
    red,
    results,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
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
  console.error("Zoho People proof failed; diagnostics retained.");
  process.exitCode = 1;
}
