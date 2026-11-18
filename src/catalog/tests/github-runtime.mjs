import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run with the prepared Basalt checkout, the GitHub source the catalog serves and a path for the
// results. GitHub is never called: fetch answers with a trimmed copy of GitHub's REST description
// and GitHub's documented response bodies, and each REST tool's result is written out unjudged.
const [root, sourcePath, resultsPath] = process.argv.slice(2);
assert.ok(root && sourcePath && resultsPath, "Pass the checkout, served source and results path");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const fixtures = join(root, "src/catalog/tests");
const document = await readFile(join(fixtures, "github-openapi.json"), "utf8");
const recorded = JSON.parse(await readFile(join(fixtures, "github-responses.json"), "utf8"));
const framework = join(root, ".upstream/packages/apps/src");
const load = (path) => import(pathToFileURL(path).href);
const directory = await mkdtemp(join(tmpdir(), "github-runtime-"));
// Only import resolution changes. Destinations, declarations and handlers stay exactly as served.
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
const description =
  "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json";
const token = "synthetic-github-token";
const repository = "https://api.github.com/repos/octocat/Hello-World";
const routes = new Map([
  [`GET ${repository}`, recorded["GET /repos/{owner}/{repo}"]],
  ["GET https://api.github.com/user/repos", recorded["GET /user/repos"]],
  [
    `GET ${repository}/actions/runners/downloads`,
    recorded["GET /repos/{owner}/{repo}/actions/runners/downloads"],
  ],
]);
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
    if (request.url === description)
      return new Response(document, { headers: { "content-type": "text/plain; charset=utf-8" } });
    assert.equal(
      request.headers.get("authorization"),
      `Bearer ${token}`,
      `${request.method} ${request.url}`,
    );
    const url = new URL(request.url);
    const body = routes.get(`${request.method} ${url.origin}${url.pathname}`);
    const text = JSON.stringify(body ?? { message: "Not Found" });
    // GitHub's own headers: a JSON media type and the length of the body as sent.
    return new Response(text, {
      status: body === undefined ? 404 : 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(new TextEncoder().encode(text).byteLength),
      },
    });
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
  const provider = requirements.value.accounts.user.github.definition;
  const account = { id: "acc_github_synthetic", provider, method: "token", fields: { token } };
  const accounts = { app: {}, user: { github: [account] } };
  const path = { owner: "octocat", repo: "Hello-World" };
  const results = {};
  for (const [tool, input] of [
    ["api.repos.get", { path }],
    ["api.repos.listForAuthenticatedUser", {}],
    ["api.actions.listRunnerApplicationsForRepo", { path }],
  ]) {
    const result = await request(
      { operation: "call", tool, input: { accountId: account.id, input } },
      accounts,
    );
    assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result).slice(0, 2_000)}`);
    results[tool] = result.value;
  }
  await writeFile(resultsPath, JSON.stringify(results));
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
