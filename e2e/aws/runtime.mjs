import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { Effect, Context, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { startScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { Actors } from "../../.upstream/e2e/support/actors.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { localNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { appsVersion } from "../../.upstream/e2e/support/apps-release.ts";
import { proveAwsPasteUi } from "./browser.mjs";
import { startAwsFixture } from "./fixture.mjs";
import { proveAwsOAuth } from "./oauth.mjs";
import { awsFailureSummary } from "./diagnostics.ts";
import { AwsProgress } from "./evidence.ts";

const [root, upstream, evidenceDirectory, browserExecutable] = process.argv.slice(2);
const require = createRequire(join(upstream, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { ElicitRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { chromium } = require("playwright");
const EVIDENCE = evidenceDirectory ?? (await mkdtemp(join(tmpdir(), "aws-proof-")));
await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
await chmod(EVIDENCE, 0o700);

let checks = 0;
let phase = "fixture";
const progress = new AwsProgress(EVIDENCE);
const enterPhase = (next) => {
  phase = next;
  progress.enter(phase, checks);
};
const check = (condition, message) => {
  checks++;
  assert.ok(condition, message);
  progress.enter(phase, checks);
};
const equal = (actual, expected, message) => {
  checks++;
  assert.deepEqual(actual, expected, message);
  progress.enter(phase, checks);
};
const inspectText = (result) =>
  JSON.stringify(result?.structuredContent ?? result?.content ?? result);
// Native `call` uses the client's prior confirmation; `execute` asks for each tool's approval.
const invoke = (client, path, input) =>
  client.callTool({
    name: "execute",
    arguments: { code: `return await ${path}(${JSON.stringify(input)})` },
  });
let request;
let checked;

const run = Effect.gen(function* () {
  check(root && upstream, "Basalt checkout and exact pinned upstream are required");
  enterPhase("fixture");
  const clientName = "Basalt AWS proof";
  const fixture = yield* Effect.acquireRelease(
    Effect.promise(() => startAwsFixture({ clientName })),
    (server) => Effect.promise(server.stop),
  );

  // OAuth state and token exchange run through the isolated self-host server APIs.
  enterPhase("environment");
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  enterPhase("registry");
  const registry = yield* localNpmRegistry;
  enterPhase("framework");
  const frameworkDirectory = join(upstream, ".local/basalt-framework");
  const framework = JSON.parse(
    yield* Effect.promise(() => readFile(join(frameworkDirectory, "framework.json"), "utf8")),
  );
  const frameworkManifest = JSON.parse(framework["package.json"]);
  equal(
    frameworkManifest.version,
    appsVersion,
    "The built framework must match the pinned host release",
  );
  enterPhase("server");
  const target = yield* startScenario(base.target, "AWS self-host MCP acceptance", undefined, {
    EXECUTOR_PRODUCT_NAME: clientName,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_APPS_FRAMEWORK: frameworkDirectory,
    EXECUTOR_APPS_VERSION: appsVersion,
  });

  enterPhase("actors");
  const services = yield* Layer.build(
    Actors.layer.pipe(
      Layer.provideMerge(SessionClients.layer),
      Layer.provideMerge(Layer.succeed(Target, target)),
    ),
  );
  const actors = Context.get(services, Actors);
  const sessions = Context.get(services, SessionClients);
  request = (actor, method, path, data) => sessions.request(actor, method, path, data);
  checked = (response, status, operation) => {
    equal(response.status, status, operation);
    return response.body;
  };
  const prefix = `/api/organizations/${actors.organization.id}`;

  const original = JSON.parse(
    yield* Effect.promise(() => readFile(join(root, "src/catalog/aws/source.json"), "utf8")),
  );
  const files = original.files.map((file) => {
    if (file.path === "provider.ts") {
      const networkPath = "https://aws-mcp.us-east-1.api.aws/mcp";
      const host = "aws-mcp.us-east-1.api.aws";
      const endpointCount = file.content.split(networkPath).length - 1;
      equal(endpointCount, 1, "AWS provider endpoint rewrite must match once");
      const hostDeclaration = `hosts: ["${host}"]`;
      equal(
        file.content.split(hostDeclaration).length - 1,
        1,
        "AWS credential host declaration rewrite must match once",
      );
      const content = file.content
        .replace(networkPath, `${fixture.origin}/mcp`)
        .replace(hostDeclaration, `hosts: ["${fixture.host}"]`);
      check(
        content.includes('loopbackRedirectUri: "http://127.0.0.1:43119/oauth/callback"'),
        "AWS must use the provider-declared loopback callback",
      );
      return { ...file, content };
    }
    if (file.path === "package.json") {
      const manifest = JSON.parse(file.content);
      equal(
        manifest.dependencies.apps,
        frameworkManifest.version,
        "The maintained AWS source must pin the exact framework release under test",
      );
    }
    return file;
  });
  yield* Effect.promise(() =>
    writeFile(
      join(EVIDENCE, "source-rewrites.json"),
      JSON.stringify(
        {
          endpoint: "https://aws-mcp.us-east-1.api.aws/mcp",
          fixtureEndpoint: `${fixture.origin}/mcp`,
          callbackIsProviderOwned: "http://127.0.0.1:43119/oauth/callback",
          files: ["provider.ts"],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    ),
  );

  enterPhase("deploy");
  const deployed = checked(
    yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: "AWS self-host MCP acceptance",
      files,
    }),
    200,
    "Deploy the maintained AWS source through self-host app management",
  );
  const app = deployed;
  yield* Effect.addFinalizer(() =>
    request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.void
          : Effect.die(new Error(`Delete the AWS proof app returned HTTP ${response.status}`)),
      ),
    ),
  );
  enterPhase("inventory");
  const inventory = checked(
    yield* request(actors.owner, "GET", `${prefix}/inventory`),
    200,
    "Read the deployed AWS app contract",
  );
  const details = inventory.apps.find((item) => item.id === app.id);
  check(details, "Deployed AWS app is missing from the inventory");
  equal(
    details.requirements.accounts.aws.scope,
    "user",
    "AWS credentials must belong to each caller",
  );
  equal(
    details.requirements.accounts.aws.cardinality,
    "many",
    "AWS must accept multiple personal accounts",
  );
  equal(
    Object.keys(details.requirements.accounts.aws.definition.auth),
    ["oauth"],
    "AWS must expose OAuth only, with no pasted-key fallback",
  );
  equal(details.requirements.accounts.aws.definition.auth.oauth.discover, `${fixture.origin}/mcp`);
  equal(details.requirements.accounts.aws.definition.auth.oauth.resource, `${fixture.origin}/mcp`);
  equal(
    details.requirements.accounts.aws.definition.auth.oauth.loopbackRedirectUri,
    "http://127.0.0.1:43119/oauth/callback",
  );
  equal(details.requirements.accounts.aws.definition.auth.oauth.scopes, []);
  equal(details.requirements.accounts.aws.definition.hosts, [fixture.host]);

  enterPhase("access");
  const access = checked(
    yield* request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
    200,
    "Read AWS app access",
  );
  checked(
    yield* request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    }),
    200,
    "Share the AWS app with the test organization",
  );

  enterPhase("oauth");
  const oauth = yield* proveAwsOAuth({
    request,
    checked,
    check,
    equal,
    actors,
    prefix,
    fixture,
    app,
  });

  enterPhase("health");
  for (const [actor, account] of [
    [actors.owner, oauth.ownerAccount],
    [actors.member, oauth.memberAccount],
  ]) {
    const health = checked(
      yield* request(actor, "POST", `${prefix}/accounts/${account}/health`),
      200,
      "Verify the personal AWS MCP account through the app health check",
    );
    const appCheck = health.apps.find((item) => item.app === app.id)?.check;
    check(
      appCheck?.status === "healthy",
      `AWS account health check failed: ${JSON.stringify(appCheck)}`,
    );
  }

  enterPhase("mcp-keys");
  const issued = [];
  for (const actor of [actors.owner, actors.member]) {
    const token = checked(
      yield* request(actor, "POST", "/api/auth/api-key/create", {
        name: "AWS managed MCP acceptance",
        metadata: { organization: actors.organization.id },
      }),
      200,
      "Issue a temporary synthetic MCP key",
    );
    issued.push({ actor, id: token.id, key: token.key });
  }
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      issued,
      ({ actor, id }) =>
        request(actor, "POST", "/api/auth/api-key/delete", { keyId: id }).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.void
              : Effect.die(new Error(`Delete the AWS proof key returned HTTP ${response.status}`)),
          ),
        ),
      { discard: true },
    ),
  );

  enterPhase("mcp-connect");
  const clients = [];
  const approvals = [];
  for (const { key } of issued) {
    let nextDecision = "accept";
    const client = new Client(
      { name: "aws-e2e", version: "1" },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, ({ params }) => {
      const decision = nextDecision;
      nextDecision = "accept";
      const callsAtPrompt = fixture
        .observations()
        .mcp.filter((event) => event.method === "tools/call").length;
      approvals.push({ message: params.message, decision, callsAtPrompt });
      return decision === "decline" ? { action: "decline" } : { action: "accept", content: {} };
    });
    const endpoint = new URL(`${target.metadata.origin}/mcp`);
    endpoint.searchParams.set("elicitation_mode", "native");
    yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
    yield* Effect.promise(() =>
      client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: {
            headers: {
              authorization: `Bearer ${key}`,
              "X-Executor-Organization": actors.organization.id,
            },
          },
        }),
      ),
    );
    clients.push(client);
    clients[clients.length - 1].nextDecision = (decision) => {
      nextDecision = decision;
    };
  }

  enterPhase("tools");
  const outcomes = [];
  for (const [index, client] of clients.entries()) {
    const ownAccount = index === 0 ? oauth.ownerAccount : oauth.memberAccount;
    const peerAccount = index === 0 ? oauth.memberAccount : oauth.ownerAccount;
    const ownIdentity = index === 0 ? "owner-reconnected" : "member";
    const peerIdentity = index === 0 ? "member" : "owner-reconnected";
    const found = yield* Effect.promise(() =>
      client.callTool({ name: "search", arguments: { query: app.slug } }),
    );
    check(found.isError !== true, "Search did not discover the installed AWS app");
    const searchText = inspectText(found);
    check(searchText.includes("get_caller_identity"), "AWS identity tool was not discovered");
    check(searchText.includes("call_aws"), "AWS service operations were not discovered");
    check(searchText.includes("execute_script"), "AWS script tool was not discovered");
    check(!searchText.includes(peerAccount), "Search exposed the other person's account");
    const tools = found.structuredContent?.items ?? [];
    const identity = tools.find((tool) => tool.path.includes("get_caller_identity"));
    check(identity, "Search omitted the account identity tool signature");
    const input = identity.input;
    const accountId = /accountId:\s*["']([^"']+)["']/.exec(input)?.[1];
    equal(accountId, ownAccount, "Search selected another account");
    check(!input.includes(peerAccount), "The caller's tool signature exposed the peer account");

    const beforeRead = fixture
      .observations()
      .mcp.filter((event) => event.method === "tools/call").length;
    const refreshesBeforeRead = fixture
      .observations()
      .refreshes.filter((event) => event.actor === ownIdentity).length;
    const approvalBeforeRead = approvals.length;
    const read = yield* Effect.promise(() =>
      invoke(client, identity.path, { accountId, input: {} }),
    );
    check(read.isError !== true, "AWS identity tool invocation failed");
    check(
      inspectText(read).includes(ownIdentity),
      "AWS read did not use the caller's linked account",
    );
    check(
      !inspectText(read).includes(peerIdentity),
      "AWS read exposed the other caller's identity",
    );
    equal(
      approvals.length,
      approvalBeforeRead + 1,
      "AWS identity reads must ask for tool approval",
    );
    equal(
      approvals.at(-1)?.callsAtPrompt,
      beforeRead,
      "AWS identity read reached the upstream server before its approval",
    );
    const afterRead = fixture.observations().mcp.filter((event) => event.method === "tools/call");
    equal(
      afterRead.length,
      beforeRead + 1,
      "Approved AWS identity read must reach the fixture once",
    );
    equal(
      afterRead.at(-1)?.tool,
      "get_caller_identity",
      "The AWS identity call used the wrong upstream tool",
    );
    equal(
      afterRead.at(-1)?.actor,
      ownIdentity,
      "The AWS identity call used another person's credentials",
    );
    const refreshesAfterRead = fixture
      .observations()
      .refreshes.filter((event) => event.actor === ownIdentity).length;
    check(
      refreshesAfterRead > refreshesBeforeRead,
      `${ownIdentity} identity read must renew its short-lived access token`,
    );

    const beforePeerRead = fixture
      .observations()
      .mcp.filter((event) => event.method === "tools/call").length;
    const peerRead = yield* Effect.promise(() =>
      invoke(client, identity.path, { accountId: peerAccount, input: {} }),
    );
    const peerFailure = peerRead.structuredContent?.execution?.error;
    check(
      peerRead.structuredContent?.execution?.ok === false &&
        peerFailure?.kind === "ToolFailure" &&
        peerFailure.response?.code === "InputInvalid" &&
        peerFailure.response?.status === 422,
      "AWS call accepted a different person's account ID",
    );
    equal(
      fixture.observations().mcp.filter((event) => event.method === "tools/call").length,
      beforePeerRead,
      "Rejected peer account read reached AWS",
    );

    for (const [toolName, input] of [
      [
        "call_aws",
        { service: "s3", operation: "CreateBucket", parameters: { Bucket: "synthetic-proof" } },
      ],
      ["execute_script", { script: "aws s3api create-bucket --bucket synthetic-proof" }],
    ]) {
      const tool = tools.find((item) => item.path.includes(toolName));
      check(tool, `Search omitted ${toolName}`);
      check(
        tool.input.includes(toolName === "call_aws" ? "service" : "script"),
        `Search omitted ${toolName}'s operation input`,
      );
      const before = fixture
        .observations()
        .mcp.filter((event) => event.method === "tools/call").length;
      const approvalBefore = approvals.length;
      client.nextDecision("decline");
      const declined = yield* Effect.promise(() => invoke(client, tool.path, { accountId, input }));
      check(
        declined.structuredContent?.execution?.ok === false,
        `Declining ${toolName} approval must reject the operation`,
      );
      equal(approvals.length, approvalBefore + 1, `${toolName} must ask for approval`);
      equal(
        approvals.at(-1)?.callsAtPrompt,
        before,
        `${toolName} reached AWS before the person approved it`,
      );
      equal(
        fixture.observations().mcp.filter((event) => event.method === "tools/call").length,
        before,
        `Declined ${toolName} reached the AWS MCP server`,
      );

      const acceptedBefore = fixture
        .observations()
        .mcp.filter((event) => event.method === "tools/call").length;
      const acceptedApprovalBefore = approvals.length;
      const approved = yield* Effect.promise(() => invoke(client, tool.path, { accountId, input }));
      check(approved.isError !== true, `Approved ${toolName} call failed`);
      equal(
        approvals.length,
        acceptedApprovalBefore + 1,
        `Approved ${toolName} must also ask for approval`,
      );
      equal(
        approvals.at(-1)?.callsAtPrompt,
        acceptedBefore,
        `Approved ${toolName} reached AWS before its approval`,
      );
      const observed = fixture.observations().mcp.filter((event) => event.method === "tools/call");
      equal(
        observed.length,
        acceptedBefore + 1,
        `Approved ${toolName} must reach the fixture exactly once`,
      );
      equal(observed.at(-1)?.tool, toolName, `Approved operation used the wrong AWS tool`);
      equal(
        observed.at(-1)?.actor,
        ownIdentity,
        `${toolName} ran with another person's credentials`,
      );
    }
    outcomes.push({
      actor: ownIdentity,
      isolatedAccount: accountId,
      readRequiresApproval: true,
      peerAccountReadRejected: true,
      identityReadRenewedGrant: true,
      apiDeclineStayedLocal: true,
      apiApproved: true,
      scriptDeclineStayedLocal: true,
      scriptApproved: true,
    });
  }

  check(
    typeof browserExecutable === "string" && browserExecutable.length > 0,
    "The AWS hosted paste proof requires the pinned Chromium executable",
  );
  enterPhase("browser");
  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ headless: true, executablePath: browserExecutable })),
    (instance) => Effect.promise(() => instance.close()),
  );
  const ownerCookies = Redacted.value(yield* actors.owner.cookies);
  enterPhase("paste-ui");
  const hostedPasteUi = yield* Effect.promise(() =>
    proveAwsPasteUi({
      browser,
      target,
      actors,
      ownerCookies,
      app,
      fixture,
      directory: EVIDENCE,
      check,
      equal,
    }),
  );

  enterPhase("refresh");
  const fixtureResult = fixture.observations();
  equal(
    fixtureResult.exchanges.length,
    6,
    "Expected owner accounts, member account, API reconnect, and hosted UI connect/reconnect authorizations",
  );
  const refreshRotation = [];
  for (const actor of ["owner-reconnected", "member"]) {
    const grant = fixtureResult.exchanges.find((event) => event.actor === actor);
    check(grant, `${actor} OAuth exchange must retain a refresh-token grant`);
    const rotations = fixtureResult.refreshes.filter((event) => event.grantId === grant.grantId);
    check(
      rotations.length >= 2,
      `${actor} must rotate its refresh token more than once through public tool calls`,
    );
    let expectedGeneration = 0;
    for (const rotation of rotations) {
      equal(
        rotation.previousGeneration,
        expectedGeneration,
        `${actor} refresh used a stale or skipped token generation`,
      );
      equal(
        rotation.issuedGeneration,
        expectedGeneration + 1,
        `${actor} refresh did not replace its prior token`,
      );
      expectedGeneration++;
    }
    equal(
      fixtureResult.staleRefreshAttempts.filter((event) => event.grantId === grant.grantId),
      [],
      `${actor} replayed a refresh token that had already been replaced`,
    );
    refreshRotation.push({
      actor,
      generations: rotations.map((rotation) => rotation.issuedGeneration),
    });
  }
  equal(fixtureResult.registrations.at(-1)?.callbacks, ["http://127.0.0.1:43119/oauth/callback"]);
  check(
    fixtureResult.registrations.every((entry) => entry.scopeCount === 0),
    "No AWS OAuth scope strings may be invented",
  );
  enterPhase("report");
  const result = {
    checks,
    oauth,
    users: outcomes,
    discoveredTools: ["get_caller_identity", "call_aws", "execute_script"],
    approvals,
    hostedPasteUi,
    oauthRefreshRotation: refreshRotation,
    accountReconnect:
      "authenticated host connection APIs preserve account ID and existing user links",
    authorizationCompletion:
      "caller pastes the full provider callback URL through the authenticated host API",
    upstream: "synthetic AWS MCP and OAuth service only",
  };
  yield* Effect.promise(() =>
    writeFile(join(EVIDENCE, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 }),
  );
  console.log(JSON.stringify(result));
  enterPhase("cleanup");
});

try {
  await Effect.runPromise(
    run.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  enterPhase("complete");
} catch (error) {
  await writeFile(join(EVIDENCE, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  await writeFile(
    join(EVIDENCE, "failure-context.json"),
    JSON.stringify(
      awsFailureSummary({
        code: 1,
        phase,
        checks,
        stderr: String(error?.stack ?? error),
      }),
    ),
    { mode: 0o600 },
  );
  console.error("AWS acceptance proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
