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
import { keyAccount, neonKey, startNeonFixture } from "./neon-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/neon-key-reuse", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const sourceBytes = await readFile(join(root, "src/catalog/neon.json"));
const beforeBytes = await readFile(join(root, "src/catalog/neon.published.json"));
process.chdir(upstream);
const results = [];
const check = (name, actual, expected) => {
  results.push({ name, actual, expected });
  assert.deepEqual(actual, expected, name);
};
const program = Effect.gen(function* () {
  // Which key reached which transport is kept on failure too.
  const fixture = yield* Effect.acquireRelease(Effect.promise(startNeonFixture), (fixture) =>
    Effect.promise(async () => {
      await writeFile(
        join(directory, "upstream-calls.json"),
        JSON.stringify(fixture.calls, null, 2),
      );
      await fixture.stop();
    }),
  );
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "Neon key reuse");
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target: prepared,
      authSecret,
      directory,
      organization: "neon-key-reuse",
      namePrefix: "neon",
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
  const restHost = new URL(fixture.rest).host;
  const mcpHost = new URL(fixture.mcp).host;
  // Only external origins and the served framework release change.
  const files = async (bytes) => {
    const source = JSON.parse(bytes);
    const localized = await localOpenapi(
      source.files
        .filter((file) => file.path !== "package.json")
        .map((file) => ({
          ...file,
          content: file.content
            .replaceAll("https://mcp.neon.tech/mcp", fixture.mcp)
            .replaceAll("https://console.neon.tech", fixture.rest)
            .replaceAll('"console.neon.tech"', JSON.stringify(restHost))
            .replaceAll('"mcp.neon.tech"', JSON.stringify(mcpHost)),
        })),
      fixture.rest,
      "neon",
    );
    fixture.documents.set("/openapi/neon.json", localized.document);
    return [
      ...localized.files,
      {
        path: "package.json",
        content: JSON.stringify({
          dependencies: { apps: appsVersion, "@modelcontextprotocol/sdk": mcpSdkVersion },
        }),
      },
    ];
  };
  const app = yield* request("POST", `${prefix}/apps/deploy`, {
    name: "Neon key reuse proof",
    files: yield* Effect.promise(() => files(beforeBytes)),
  });
  const path = `${prefix}/apps/${app.id}`;
  const providers = (requirements) => ({
    neon: requirements.accounts.neon.provider,
    neonMcp: requirements.accounts.neonMcp.provider,
  });
  const before = providers(app.requirements);
  const saveKey = (requirement, label, account) =>
    Effect.gen(function* () {
      const connection = yield* request(
        "POST",
        `${path}/accounts/user/${requirement}/connections`,
        account === undefined ? {} : { account },
      );
      const saved = yield* request("POST", `${prefix}/connections/${connection.id}/submit`, {
        method: "apiKey",
        label,
        fields: { token: neonKey(label) },
      });
      return { id: saved.id, key: neonKey(label), account: keyAccount(neonKey(label)) };
    });
  const toolNames = (index) => index.items.map((item) => item.name).sort();
  const unavailable = (index) =>
    index.routers
      .filter((entry) => entry.title === "Unavailable account source")
      .map((entry) => ({
        router: entry.path.split(".")[0],
        account: entry.description,
        message: entry.error?.message,
      }));
  const index = (name) =>
    request("GET", `${path}/tools/index`).pipe(
      Effect.tap((body) =>
        Effect.promise(() => writeFile(join(directory, name), JSON.stringify(body, null, 2))),
      ),
    );
  // What the account's row shows: its check and any status badges.
  const health = (account) =>
    request("POST", `${prefix}/accounts/${account.id}/health`).pipe(
      Effect.map((body) => {
        const check = body.apps.find((entry) => entry.app === app.id)?.check;
        return { status: check?.status, badges: check?.displayStatus?.badges ?? [] };
      }),
    );
  const reconnect = (tools) => ({
    status: "healthy",
    badges: [{ label: `Reconnect to use this key for the ${tools}`, tone: "warning" }],
  });
  const restTool = "api.fixture.read";
  const mcpTool = "mcp.list_projects";
  const attempt = (tool, account) =>
    response("POST", `${path}/tools/call`, { tool, input: { accountId: account.id, input: {} } });
  const call = (tool, account) =>
    attempt(tool, account).pipe(
      Effect.map((result) => {
        assert.equal(result.status, 200, `${tool}: ${JSON.stringify(result.body)}`);
        return result.body.content === undefined
          ? result.body
          : JSON.parse(result.body.content.find((item) => item.type === "text").text);
      }),
    );
  // The network refuses a key outside its account's hosts before the request leaves.
  const refused = (tool, account, transport) =>
    Effect.gen(function* () {
      const from = fixture.calls.length;
      const result = yield* attempt(tool, account);
      yield* Effect.promise(() =>
        writeFile(join(directory, `refused-${transport}.json`), JSON.stringify(result, null, 2)),
      );
      return {
        status: result.status,
        failure: { code: result.body.failure?.code, message: result.body.failure?.message },
        sent: fixture.calls
          .slice(from)
          .filter((entry) => entry.transport === transport)
          .map((entry) => entry.credential),
      };
    });

  // As published, a REST key reaches only the REST API and adds no MCP tools.
  const earlierRest = yield* saveKey("neon", "Earlier REST key");
  check("published: only the REST tool", toolNames(yield* index("published-index.json")), [
    restTool,
  ]);
  const earlierMcp = yield* saveKey("neonMcp", "Earlier MCP key");

  yield* request("POST", `${path}/deploy`, {
    files: yield* Effect.promise(() => files(sourceBytes)),
  });
  const updated = yield* request("GET", path);
  check("both providers keep their identity", providers(updated.requirements), before);

  // Keys saved before the update keep only the host they were saved for until reconnected.
  const earlier = yield* index("carried-earlier-index.json");
  check("carried: both tools listed", toolNames(earlier), [restTool, mcpTool]);
  // MCP lists tools with the key, so the earlier REST key shows as unavailable there.
  check("earlier REST key shows as unavailable for MCP, naming the host", unavailable(earlier), [
    {
      router: "mcp",
      account: `Account ${earlierRest.id}`,
      message: `Refused this request: Neon credentials cannot be sent to ${mcpHost}. The provider allows: ${restHost}.`,
    },
  ]);
  check("earlier REST key runs a REST tool", yield* call(restTool, earlierRest), {
    transport: "rest",
    account: earlierRest.account,
  });
  // Other MCP accounts list their tools during the call, so only this key must be absent.
  const mcpRefusal = yield* refused(mcpTool, earlierRest, "mcp");
  check(
    "earlier REST key is refused by the MCP host",
    { ...mcpRefusal, sent: mcpRefusal.sent.filter((key) => key === earlierRest.key) },
    {
      status: 502,
      failure: {
        code: "credential_host",
        message: `Refused this request: Neon credentials cannot be sent to ${mcpHost}. The provider allows: ${restHost}.`,
      },
      sent: [],
    },
  );
  check("earlier MCP key runs an MCP tool", yield* call(mcpTool, earlierMcp), {
    transport: "mcp",
    account: earlierMcp.account,
  });
  // REST lists its tools without the key, so an earlier MCP key is only refused when it calls one,
  // and the REST router reports that refusal as a request that got no response.
  check(
    "earlier MCP key is refused by the REST host",
    yield* refused(restTool, earlierMcp, "rest"),
    {
      status: 502,
      failure: { code: "request", message: "GET /fixture/read failed before a response arrived." },
      sent: [],
    },
  );

  // Each earlier key's row says to reconnect it for the other part, without failing its check.
  check(
    "earlier REST key's row says to reconnect for MCP",
    yield* health(earlierRest),
    reconnect("MCP tools"),
  );
  check(
    "earlier MCP key's row says to reconnect for REST",
    yield* health(earlierMcp),
    reconnect("REST API tools"),
  );

  // Reconnecting an earlier key grants it the hosts listed now.
  yield* saveKey("neon", "Earlier REST key", earlierRest.id);
  yield* saveKey("neonMcp", "Earlier MCP key", earlierMcp.id);
  const noNote = { status: "healthy", badges: [] };
  for (const account of [earlierRest, earlierMcp])
    check(`reconnected ${account.account} row has no note`, yield* health(account), noNote);
  check(
    "reconnected keys leave no unavailable source",
    unavailable(yield* index("reconnected-index.json")),
    [],
  );
  check("reconnected REST key runs an MCP tool", yield* call(mcpTool, earlierRest), {
    transport: "mcp",
    account: earlierRest.account,
  });
  check("reconnected MCP key runs a REST tool", yield* call(restTool, earlierMcp), {
    transport: "rest",
    account: earlierMcp.account,
  });

  // A key saved for either requirement after the update serves both transports itself.
  const restKey = yield* saveKey("neon", "REST key");
  check("REST key runs a REST tool", yield* call(restTool, restKey), {
    transport: "rest",
    account: restKey.account,
  });
  check("REST key runs an MCP tool", yield* call(mcpTool, restKey), {
    transport: "mcp",
    account: restKey.account,
  });
  const mcpKey = yield* saveKey("neonMcp", "MCP key");
  check("MCP key runs a REST tool", yield* call(restTool, mcpKey), {
    transport: "rest",
    account: mcpKey.account,
  });
  check("MCP key runs an MCP tool", yield* call(mcpTool, mcpKey), {
    transport: "mcp",
    account: mcpKey.account,
  });
  // A new key's check asks the other host with the key itself, which the network lets through.
  const probes = (account) =>
    Effect.gen(function* () {
      const from = fixture.calls.length;
      const result = yield* health(account);
      return {
        ...result,
        asked: fixture.calls
          .slice(from)
          .filter((entry) => entry.method === "HEAD" && entry.credential === account.key)
          .map((entry) => entry.transport),
      };
    });
  check("new REST key's row has no note", yield* probes(restKey), { ...noNote, asked: ["mcp"] });
  check("new MCP key's row has no note", yield* probes(mcpKey), { ...noNote, asked: ["rest"] });
  return {
    results,
    earlierAccounts: [earlierRest.id, earlierMcp.id],
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
  console.error("Neon key reuse proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
