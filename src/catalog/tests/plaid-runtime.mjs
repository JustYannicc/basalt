import { assertProviderContinuity } from "./plaid-provider-continuity.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run with the prepared Basalt checkout, optionally overriding candidate and baseline paths.
const root = process.argv[2];
assert.ok(root, "Pass the prepared Basalt checkout as the first argument");
const source = JSON.parse(
  await readFile(process.argv[3] ?? join(root, "src/catalog/plaid.json"), "utf8"),
);
const published = JSON.parse(
  await readFile(process.argv[4] ?? join(root, "src/catalog/plaid.published.json"), "utf8"),
);
const framework = join(root, ".upstream/packages/apps/src");
const sdk = join(root, ".upstream/packages/sdk/src");
const requireSdk = createRequire(join(root, ".upstream/packages/sdk/package.json"));
const load = (path) => import(pathToFileURL(path).href);
const { Effect } = await load(requireSdk.resolve("effect"));
const { FetchHttpClient, HttpClient } = await load(requireSdk.resolve("effect/http"));
const directory = await mkdtemp(join(tmpdir(), "plaid-runtime-"));
const endpoint = "https://api.dashboard.plaid.com/mcp/";
const tokenUrl = "https://production.plaid.com/oauth/token";
const client = {
  client_id: "synthetic-plaid-production-client",
  client_secret: "synthetic-plaid-production-secret",
};
const legacyAccess = "synthetic-plaid-legacy-access";
const exchanges = [];
const calls = [];
const originalFetch = globalThis.fetch;
const publicExports = {
  apps: "index.ts",
  "apps/mcp": "mcp.ts",
  "apps/openapi": "openapi.ts",
  "apps/operations/approval": "approval.ts",
};
const rewriteImports = (content) => {
  for (const [name, file] of Object.entries(publicExports))
    content = content.replaceAll(
      JSON.stringify(name),
      JSON.stringify(pathToFileURL(join(framework, file)).href),
    );
  return content;
};
try {
  // Only public SDK import resolution changes. All served declarations and destinations remain.
  for (const file of source.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      file.path.endsWith(".ts") ? rewriteImports(file.content) : file.content,
    );
  }
  await writeFile(
    join(directory, "original.ts"),
    rewriteImports(published.files.find((file) => file.path === "index.ts").content),
  );
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === tokenUrl) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("content-type")?.split(";")[0], "application/json");
      assert.equal(
        request.headers.has("authorization"),
        false,
        "Client secret POST must not become Basic auth",
      );
      const body = await request.json();
      assert.deepEqual(body, {
        grant_type: "client_credentials",
        ...client,
        scope: "mcp:dashboard",
      });
      exchanges.push({ url: request.url, body });
      return Response.json({
        access_token: `synthetic-plaid-machine-access-${exchanges.length}`,
        token_type: "Bearer",
        expires_in: 900,
        scope: "mcp:dashboard",
      });
    }
    assert.equal(
      request.url,
      endpoint,
      "No discovery, Sandbox exchange, REST call or other destination is allowed",
    );
    const authorization = request.headers.get("authorization");
    const machine = /^Bearer synthetic-plaid-machine-access-[12]$/.test(authorization ?? "");
    const authorized = machine || authorization === `Bearer ${legacyAccess}`;
    const serialized = JSON.stringify([...request.headers]);
    assert.equal(serialized.includes(client.client_id), false);
    assert.equal(serialized.includes(client.client_secret), false);
    assert.equal(request.headers.has("plaid-client-id"), false);
    assert.equal(request.headers.has("plaid-secret"), false);
    calls.push({ authorized, machine, url: request.url });
    if (!authorized)
      return new Response("", { status: 401, headers: { "www-authenticate": "Bearer" } });
    if (request.method === "GET") return new Response("", { status: 405 });
    if (request.method === "DELETE") return new Response("", { status: 200 });
    assert.equal(request.method, "POST");
    const text = await request.text();
    assert.equal(text.includes(client.client_id), false);
    assert.equal(text.includes(client.client_secret), false);
    const message = JSON.parse(text);
    calls.push({ rpc: message.method, machine });
    if (message.id === undefined) return new Response("", { status: 202 });
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "Plaid fixture", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "diagnose-item",
            description: "Read diagnostics",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: "change-item",
            description: "Change an item",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false },
          },
          {
            name: "unknown-action",
            description: "No safety hint",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    else if (message.method === "tools/call") {
      assert.equal(message.params.name, "diagnose-item", "Unapproved writes must not reach MCP");
      result = {
        content: [{ type: "text", text: "Synthetic diagnostics" }],
        structuredContent: { found: true, accountKind: machine ? "machine" : "legacy" },
      };
    } else throw new Error("Unexpected MCP method");
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
  const host = await load(join(framework, "host.ts"));
  const handler = host.createAppHandler((await load(join(directory, "index.ts"))).default);
  const originalHandler = host.createAppHandler(
    (await load(join(directory, "original.ts"))).default,
  );
  const request = async (command, accounts = { app: {} }, dispatch = handler) => {
    const response = await dispatch(
      new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify(command) }),
      host.hostContext(accounts),
    );
    return { status: response.status, body: await response.json() };
  };
  const invoke = async (command, accounts, dispatch) => {
    const result = await request(command, accounts, dispatch);
    assert.equal(result.status, 200, JSON.stringify({ command, result: result.body }));
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    return result.body.value;
  };
  const requirements = await invoke({ operation: "requirements" });
  const original = await invoke({ operation: "requirements" }, undefined, originalHandler);
  assert.deepEqual(Object.keys(requirements.accounts.user).sort(), ["plaid", "plaidMcp"]);
  const rest = requirements.accounts.user.plaid.definition;
  const active = requirements.accounts.user.plaidMcp.definition;
  const oldMcp = original.accounts.user.plaidMcp.definition;
  assert.deepEqual(
    rest,
    original.accounts.user.plaid.definition,
    "REST definition must be unchanged",
  );
  assert.deepEqual(active.auth.oauth, oldMcp.auth.oauth, "Existing DCR OAuth method must be exact");
  const { auth: activeAuth, ...activeMetadata } = active;
  const { auth: oldAuth, ...oldMetadata } = oldMcp;
  assert.deepEqual(activeMetadata, oldMetadata);
  assert.deepEqual(Object.keys(activeAuth).sort(), ["clientCredentials", "oauth"]);
  assert.deepEqual(Object.keys(oldAuth), ["oauth"]);
  assert.deepEqual(active.hosts, ["api.dashboard.plaid.com"]);
  for (const slot of ["plaid", "plaidMcp"])
    assert.deepEqual(
      { ...requirements.accounts.user[slot], definition: null },
      { ...original.accounts.user[slot], definition: null },
    );
  const method = active.auth.clientCredentials;
  assert.equal(method.type, "oauth2");
  assert.equal(method.grant, "client_credentials");
  assert.equal(method.tokenUrl, tokenUrl);
  assert.equal(method.tokenEndpointAuthMethod, "client_secret_post");
  assert.equal(method.tokenRequestFormat, "json");
  assert.equal(method.resource, null);
  assert.deepEqual(method.scopes, ["mcp:dashboard"]);
  const { makeOAuthProtocol } = await load(join(sdk, "oauth-protocol.ts"));
  const tokens = await Effect.runPromise(
    Effect.gen(function* () {
      const protocol = makeOAuthProtocol({
        httpClient: yield* HttpClient.HttpClient,
        clientName: "Plaid synthetic proof",
        urlPolicy: { allowLoopbackHttp: false, allowedHttpOrigins: [] },
      });
      const discovered = yield* protocol.discover(method);
      assert.equal(discovered.grant, "client_credentials");
      assert.equal(discovered.resource, undefined);
      assert.equal(
        exchanges.length,
        0,
        "Explicit machine configuration must not perform discovery HTTP",
      );
      const input = {
        ...discovered,
        client: { ...client, token_endpoint_auth_method: discovered.tokenEndpointAuthMethod },
      };
      const first = yield* protocol.clientCredentials(input);
      const second = yield* protocol.clientCredentials(input);
      assert.equal(first.expires_in, 900);
      assert.equal(second.expires_in, 900);
      assert.notEqual(first.access_token, second.access_token);
      return first;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  assert.equal(
    exchanges.length,
    2,
    "Both native exchanges must use the same exact machine JSON contract",
  );
  assert.ok(
    exchanges.every(
      (exchange) => exchange.url === tokenUrl && !Object.hasOwn(exchange.body, "resource"),
    ),
  );

  await assertProviderContinuity(root, original, requirements);

  for (const [methodName, accessToken, accountKind] of [
    ["oauth", legacyAccess, "legacy"],
    ["clientCredentials", tokens.access_token, "machine"],
  ]) {
    const account = {
      id: `acc_plaid_${accountKind}`,
      provider: active,
      method: methodName,
      fields: { access_token: accessToken },
    };
    const accounts = { app: {}, user: { plaid: [], plaidMcp: [account] } };
    const beforeHealth = calls.length;
    assert.deepEqual(
      await invoke(
        { operation: "account-check", requirement: "plaidMcp" },
        { app: {}, user: { plaidMcp: account } },
      ),
      {},
    );
    assert.ok(calls.slice(beforeHealth).some((call) => call.authorized === true));
    assert.ok(
      calls.slice(beforeHealth).some((call) => call.authorized === false),
      "Health must prove anonymous refusal",
    );
    const catalog = await invoke({ operation: "inspect" }, accounts);
    assert.deepEqual(
      catalog.tools.map((tool) => [tool.name, tool.readOnly]),
      [
        ["mcp.diagnose-item", true],
        ["mcp.change-item", false],
        ["mcp.unknown-action", false],
      ],
    );
    const input = { accountId: account.id, input: {} };
    const read = await invoke({ operation: "call", tool: "mcp.diagnose-item", input }, accounts);
    assert.deepEqual(read.structuredContent, { found: true, accountKind });
    for (const tool of ["mcp.change-item", "mcp.unknown-action"]) {
      const beforeWrite = calls.filter((call) => call.rpc === "tools/call").length;
      const write = await request({ operation: "call", tool, input }, accounts);
      assert.equal(write.body.ok, false);
      assert.equal(write.body.error._tag, "HostToolApprovalRequired");
      assert.equal(calls.filter((call) => call.rpc === "tools/call").length, beforeWrite);
    }
  }
  assert.ok(calls.some((call) => call.rpc === "tools/call" && call.machine));
  assert.ok(calls.some((call) => call.rpc === "tools/call" && call.machine === false));
  assert.equal(exchanges.length, 2, "App tools must consume projected tokens, not mint their own");
  console.log(
    "Plaid declarations, native machine JSON exchange, additive provider continuity, both MCP account methods, health, reads and write approvals PASS",
  );
  console.log(
    "Not covered: persisted grant expiry/renewal, stored-account deployment migration, live vendor credentials, or PR C REST-account reuse",
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
