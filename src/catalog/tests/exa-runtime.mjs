import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run with the prepared Basalt checkout. Exa is never called: fetch answers from a trimmed copy
// of Exa's OpenAPI document and from synthetic statuses.
const root = process.argv[2];
assert.ok(root, "Pass the prepared Basalt checkout as the first argument");
const print = process.argv[3] === "--print-kinds";
const source = JSON.parse(await readFile(join(root, "src/catalog/exa.json"), "utf8"));
const document = await readFile(join(root, "src/catalog/tests/exa-openapi.json"), "utf8");
const framework = join(root, ".upstream/packages/apps/src");
const load = (path) => import(pathToFileURL(path).href);
const directory = await mkdtemp(join(tmpdir(), "exa-runtime-"));
const publicExports = {
  apps: "index.ts",
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
const token = "synthetic-exa-key";
let health = 200;
const calls = [];
const originalFetch = globalThis.fetch;
try {
  for (const file of source.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      file.path.endsWith(".ts") ? rewriteImports(file.content) : file.content,
    );
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://api.exa.ai/openapi.json")
      return new Response(document, { headers: { "content-type": "application/json" } });
    assert.equal(request.headers.get("x-api-key"), token, `${request.method} ${request.url}`);
    calls.push(`${request.method} ${request.url}`);
    if (request.url.endsWith("/v0/teams/me"))
      return health === 200
        ? Response.json({ id: "synthetic-team" })
        : new Response("", { status: health });
    return Response.json({ results: [] });
  };
  const host = await load(join(framework, "host.ts"));
  const handler = host.createAppHandler((await load(join(directory, "index.ts"))).default);
  const request = async (command, accounts) => {
    const response = await handler(
      new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify(command) }),
      host.hostContext(accounts),
    );
    return await response.json();
  };
  const requirements = await request({ operation: "requirements" }, { app: {} });
  assert.equal(requirements.ok, true, JSON.stringify(requirements));
  const provider = requirements.value.accounts.user.exa.definition;
  const account = { id: "acc_exa_synthetic", provider, method: "apiKey", fields: { token } };
  const check = () =>
    request(
      { operation: "account-check", requirement: "exa" },
      { app: {}, user: { exa: account } },
    );

  // The account check reads the operation's own Websets server; only 401 and 403 are refusals.
  const outcomes = {};
  for (const status of [200, 401, 403, 404, 429, 503]) {
    health = status;
    calls.length = 0;
    const result = await check();
    assert.deepEqual(calls, ["GET https://api.exa.ai/websets/v0/teams/me"]);
    outcomes[status] = result.ok ? "verified" : result.error;
  }
  assert.equal(outcomes[200], "verified");
  assert.equal(outcomes[401]._tag, "ProviderError");
  assert.equal(outcomes[401].reason, "unauthorized");
  assert.equal(outcomes[403]._tag, "ProviderError");
  assert.equal(outcomes[403].reason, "rejected");
  assert.equal(outcomes[429].reason, "rate_limited");
  assert.equal(outcomes[503].reason, "unavailable");
  for (const status of [404]) {
    const text = JSON.stringify(outcomes[status]);
    assert.doesNotMatch(text, /rejected|unauthorized/i, `${status} must not read as a refusal`);
    assert.match(text, new RegExp(`HTTP ${status}`), text);
  }

  // The hand-written tools are queries and run without approval.
  const accounts = { app: {}, user: { exa: [account] } };
  const inspected = await request({ operation: "inspect" }, accounts);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const custom = inspected.value.tools.filter((tool) => tool.name.startsWith("custom."));
  assert.deepEqual(
    custom.map((tool) => [tool.name, tool.readOnly]),
    [
      ["custom.search", true],
      ["custom.answer", true],
    ],
  );
  for (const [tool, path] of [
    ["custom.search", "/search"],
    ["custom.answer", "/answer"],
  ]) {
    calls.length = 0;
    const result = await request(
      { operation: "call", tool, input: { accountId: account.id, input: { query: "synthetic" } } },
      accounts,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls, [`POST https://api.exa.ai${path}`]);
  }

  // Every generated tool's kind, as the live router derives it from the carried options.
  const { options } = await load(join(directory, "openapi.ts"));
  const { openapiToolNames } = await load(join(framework, "implementation/openapi-source.ts"));
  const { tools } = await openapiToolNames({ ...options, fetch: globalThis.fetch });
  const kinds = Object.fromEntries(tools.map((tool) => [tool.operationId, tool.kind]));
  if (print) console.log(JSON.stringify(kinds, null, 2));
  else {
    const pinned = JSON.parse(
      await readFile(join(root, "src/catalog/tests/exa-kinds.json"), "utf8"),
    );
    assert.deepEqual(kinds, pinned, "every Exa operation keeps its pinned kind");
    console.log("Exa account check, custom query tools and every generated operation's kind PASS");
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
