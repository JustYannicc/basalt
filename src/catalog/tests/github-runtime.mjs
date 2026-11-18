import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run with the prepared Basalt checkout, the GitHub source the catalog serves and a path for the
// results. GitHub is never called: fetch answers with a trimmed copy of GitHub's REST description
// and GitHub's documented response bodies, and each REST tool's result is written out unjudged.
// One more repository answers with a JSON body larger than the router reads, sent only as fast as
// it is read, so the results also say how much of it anything read.
const [root, sourcePath, resultsPath] = process.argv.slice(2);
assert.ok(root && sourcePath && resultsPath, "Pass the checkout, served source and results path");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const fixtures = join(root, "src/catalog/tests");
const document = await readFile(join(fixtures, "github-openapi.json"), "utf8");
const recorded = JSON.parse(await readFile(join(fixtures, "github-responses.json"), "utf8"));
const framework = join(root, ".upstream/packages/apps/src");
const load = (path) => import(pathToFileURL(path).href);
// The REST router keeps GitHub's compiled description in the host's app cache. This is the cache
// a Durable Object gives apps, on an in-memory database, behind the same isolated boundary: a
// failure crosses it as an encoded reply that keeps the store's own reason.
const appCache = join(root, ".upstream/packages/app-cache/src");
const { sqliteCache } = await load(join(appCache, "sqlite.ts"));
const { CacheReply } = await load(join(appCache, "contracts/cache.ts"));
const { Effect, Schema } = await load(createRequire(join(appCache, "sqlite.ts")).resolve("effect"));
const host = await load(join(framework, "host.ts"));
const database = new Database(":memory:");
const cached = sqliteCache({
  sql: {
    exec: (query, ...bindings) => {
      const rows = database.query(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0] };
    },
  },
  transactionSync: (work) => database.transaction(work)(),
});
// The SQLite cache resolves its reply bare on this framework pin and as { reply, replaced } on the
// next; no reply has a `replaced` field of its own.
const replyOf = (result) =>
  typeof result === "object" && result !== null && "replaced" in result ? result.reply : result;
const session = host.isolatedCacheSession((command) =>
  Effect.runPromise(
    cached("github", command).pipe(
      Effect.map(replyOf),
      Effect.match({
        onSuccess: (value) => ({ ok: true, value }),
        onFailure: (error) => ({ ok: false, error }),
      }),
      Effect.flatMap(Schema.encodeEffect(CacheReply)),
    ),
  ),
);
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
const oversized = { total: 32 * 1_048_576, sent: 0 };
const megabyte = new TextEncoder().encode("a".repeat(1_048_576));
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
    if (url.pathname === "/repos/octocat/oversized")
      return new Response(
        new ReadableStream({
          pull: (controller) => {
            if (oversized.sent >= oversized.total) return controller.close();
            const next =
              oversized.sent === 0 ? new TextEncoder().encode('{"description":"') : megabyte;
            oversized.sent += next.byteLength;
            controller.enqueue(next);
          },
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
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
  const handler = host.createAppHandler((await load(join(directory, "index.ts"))).default);
  const request = async (command, accounts) => {
    const response = await handler(
      new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify(command) }),
      { ...host.hostContext(accounts), cache: session.cache },
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
  const refused = await request(
    {
      operation: "call",
      tool: "api.repos.get",
      input: { accountId: account.id, input: { path: { owner: "octocat", repo: "oversized" } } },
    },
    accounts,
  );
  await writeFile(
    resultsPath,
    JSON.stringify({
      results,
      oversized: { ok: refused.ok, error: refused.error, ...oversized },
    }),
  );
} finally {
  await session.cancel();
  globalThis.fetch = originalFetch;
  database.close();
  await rm(directory, { recursive: true, force: true });
}
