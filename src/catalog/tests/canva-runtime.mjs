import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const framework = join(root, ".upstream/packages/apps/src");
const source = JSON.parse(await readFile(join(root, "src/catalog/canva.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "canva-runtime-"));
const endpoint = "https://api.canva.com/connect/v1/mcp";
const calls = [];

// Only import resolution changes. Destinations, declarations and handlers stay exactly as served.
const publicExports = {
  apps: "index.ts",
  "apps/mcp": "mcp.ts",
  "apps/openapi": "openapi.ts",
  "apps/operations/approval": "approval.ts",
};
try {
  for (const file of source.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    let content = file.content;
    if (file.path.endsWith(".ts"))
      for (const [name, file] of Object.entries(publicExports))
        content = content.replaceAll(
          JSON.stringify(name),
          JSON.stringify(pathToFileURL(join(framework, file)).href),
        );
    await writeFile(target, content);
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.ok([endpoint, "https://mcp.canva.com/mcp"].includes(request.url));
    const authorized = request.headers.get("authorization") === "Bearer synthetic-canva-access";
    calls.push({ authorized, url: request.url });
    if (!authorized)
      return new Response("", { status: 401, headers: { "www-authenticate": "Bearer" } });
    if (request.method === "GET") return new Response("", { status: 405 });
    if (request.method === "DELETE") return new Response("", { status: 200 });
    const message = await request.json();
    calls.push({ rpc: message.method });
    if (message.id === undefined) return new Response("", { status: 202 });
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "Canva fixture", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "search-designs",
            description: "Find designs",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: "create-design",
            description: "Create a design",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false },
          },
        ],
      };
    else if (message.method === "tools/call") {
      assert.equal(message.params.name, "search-designs", "Unapproved writes must not reach MCP");
      result = {
        content: [{ type: "text", text: "Synthetic design" }],
        structuredContent: { found: true },
      };
    } else throw new Error("Unexpected MCP method");
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
  const published = JSON.parse(
    await readFile(join(root, "src/catalog/canva.published.json"), "utf8"),
  );
  let originalIndex = published.files.find((file) => file.path === "index.ts").content;
  for (const [name, file] of Object.entries(publicExports))
    originalIndex = originalIndex.replaceAll(
      JSON.stringify(name),
      JSON.stringify(pathToFileURL(join(framework, file)).href),
    );
  await writeFile(join(directory, "original.ts"), originalIndex);
  const app = (await import(pathToFileURL(join(directory, "index.ts")).href)).default;
  const host = await import(pathToFileURL(join(framework, "host.ts")).href);
  const handler = host.createAppHandler(app);
  const request = async (command, accounts = { app: {} }) => {
    const response = await handler(
      new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify(command) }),
      host.hostContext(accounts),
    );
    return { status: response.status, body: await response.json() };
  };
  const invoke = async (command, accounts) => {
    const result = await request(command, accounts);
    assert.equal(result.status, 200, JSON.stringify({ command, result: result.body }));
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    return result.body.value;
  };
  const requirements = await invoke({ operation: "requirements" });
  const definition = requirements.accounts.user.canvaConnectMcp.definition;
  const legacyDefinition = requirements.accounts.user.canvaMcp.definition;
  const originalHandler = host.createAppHandler(
    (await import(pathToFileURL(join(directory, "original.ts")).href)).default,
  );
  const originalResponse = await originalHandler(
    new Request("https://fixture.invalid", {
      method: "POST",
      body: JSON.stringify({ operation: "requirements" }),
    }),
    host.hostContext({ app: {} }),
  );
  const originalRequirements = (await originalResponse.json()).value;
  assert.deepEqual(legacyDefinition, originalRequirements.accounts.user.canvaMcp.definition);
  assert.deepEqual(
    requirements.accounts.user.canva.definition,
    originalRequirements.accounts.user.canva.definition,
  );

  assert.equal(legacyDefinition.auth.oauth.discover, "https://mcp.canva.com/mcp");
  assert.deepEqual(legacyDefinition.hosts, ["mcp.canva.com"]);
  assert.equal(definition.auth.oauth.discover, endpoint);
  assert.deepEqual(definition.hosts, ["api.canva.com"]);
  const account = {
    id: "acc_canva_fixture",
    provider: definition,
    method: "oauth",
    fields: { access_token: "synthetic-canva-access" },
  };
  const accounts = { app: {}, user: { canva: [], canvaMcp: [], canvaConnectMcp: [account] } };
  assert.deepEqual(
    await invoke(
      { operation: "account-check", requirement: "canvaConnectMcp" },
      { app: {}, user: { canvaConnectMcp: account } },
    ),
    {},
  );
  assert.ok(
    calls.some((call) => call.authorized === false),
    "Health must test unauthenticated refusal too",
  );
  const catalog = await invoke({ operation: "inspect" }, accounts);
  assert.deepEqual(
    catalog.tools.map((tool) => [tool.name, tool.readOnly]),
    [
      ["mcp.search-designs", true],
      ["mcp.create-design", false],
    ],
  );
  const input = { accountId: account.id, input: {} };
  const read = await invoke({ operation: "call", tool: "mcp.search-designs", input }, accounts);
  assert.equal(read.structuredContent.found, true);
  const beforeWrite = calls.filter((call) => call.rpc === "tools/call").length;
  const write = await request({ operation: "call", tool: "mcp.create-design", input }, accounts);
  assert.equal(write.body.ok, false);
  assert.equal(write.body.error._tag, "HostToolApprovalRequired");
  assert.equal(calls.filter((call) => call.rpc === "tools/call").length, beforeWrite);
  const beforeLegacy = calls.length;
  const legacyAccount = { ...account, id: "acc_canva_legacy", provider: legacyDefinition };
  await invoke(
    { operation: "account-check", requirement: "canvaMcp" },
    { app: {}, user: { canvaMcp: legacyAccount } },
  );
  assert.ok(calls.length > beforeLegacy);
  assert.ok(
    calls
      .slice(beforeLegacy)
      .every((call) => !call.url || call.url === "https://mcp.canva.com/mcp"),
  );
  const wrongSlot = await request(
    { operation: "account-check", requirement: "canvaConnectMcp" },
    { app: {}, user: { canvaConnectMcp: legacyAccount } },
  );
  assert.equal(wrongSlot.body.ok, false);
  assert.equal(wrongSlot.body.error._tag, "HostAccountsInvalid");
  console.log(
    "Canva MCP health, discovery, read, write approval and legacy-account preservation PASS",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
