import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-metadata.ts";
import { onServedFramework } from "./framework.ts";
import { githubSource } from "./github.ts";
import reviews from "./oauth-reviews.json" with { type: "json" };
import { handleCatalog } from "./worker.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = (suffix: string) => readFileSync(new URL(`./github.${suffix}`, import.meta.url));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const temporary = new Set(["temp_clone_token", "temp_download_token"]);
const dropTemporary = (key: string, value: unknown) => (temporary.has(key) ? undefined : value);
// What GitHub's minting endpoints return, and what a person may ask a tool to mint.
const minted = new Set(["token", "encoded_jit_config", "client_secret", "webhook_secret", "pem"]);
const omit = (body: unknown, field: string) => {
  const { [field]: _dropped, ...rest } = body as Record<string, unknown>;
  return rest;
};

/** Every path at which a credential appears: a credential field, or a link carrying a token. */
const credentialPaths = (value: unknown, path = "$"): string[] =>
  typeof value === "string"
    ? /[?&]token=/.test(value)
      ? [path]
      : []
    : Array.isArray(value)
      ? value.flatMap((item, index) => credentialPaths(item, `${path}[${index}]`))
      : typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, item]) =>
            temporary.has(key) || minted.has(key) || (key === "secret" && "secret_type" in value)
              ? [`${path}.${key}`]
              : credentialPaths(item, `${path}.${key}`),
          )
        : [];

type ServedRun = {
  results: Record<string, unknown>;
  oversized: { ok: boolean; error: unknown; sent: number; total: number };
  unapproved: unknown;
  tools: string[];
  minting: string[];
};
let ran: Promise<ServedRun> | undefined;
/** What the package the catalog serves did with GitHub's recorded answers, run once for every test. */
const servedRun = () =>
  (ran ??= (async () => {
    // The publisher, if asked, answers with the package it published.
    const served = await handleCatalog(
      new Request("https://catalog.example.test/catalog/apps/github.json"),
      async (input) => {
        assert.equal(String(input), "https://catalog.executor.sh/apps/github.json");
        return new Response(bytes("published.json").toString());
      },
    );
    assert.equal(served.status, 200);
    const directory = mkdtempSync(join(tmpdir(), "github-served-"));
    try {
      const source = join(directory, "github.json");
      const output = join(directory, "results.json");
      writeFileSync(source, await served.text());
      execFileSync(
        "bun",
        [new URL("./tests/github-runtime.mjs", import.meta.url).pathname, root, source, output],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      return JSON.parse(readFileSync(output, "utf8")) as ServedRun;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })());

// GitHub answers these only for an OAuth or GitHub app's own client ID and secret, sent as Basic
// credentials: its REST reference marks exactly these five so, and no other operation. A connected
// account holds a person's token, which they refuse.
const appCredentialTools = [
  "api.apps.checkToken",
  "api.apps.deleteAuthorization",
  "api.apps.deleteToken",
  "api.apps.resetToken",
  "api.apps.scopeToken",
];

test("GitHub's REST tools leave out the operations that take an app's client ID and secret", async () => {
  // The description the run reads declares all five under these paths, as GitHub's does, and
  // nothing else there.
  const description = JSON.parse(
    readFileSync(new URL("./tests/github-openapi.json", import.meta.url), "utf8"),
  ) as { paths: Record<string, Record<string, { operationId: string }>> };
  const operations = Object.entries(description.paths).flatMap(([path, item]) =>
    Object.values(item).map(({ operationId }) => ({ path, operationId })),
  );
  const appOnly = operations.filter(({ path }) => path.startsWith("/applications/{client_id}/"));
  assert.deepEqual(appOnly.map(({ operationId }) => operationId).sort(), [
    "apps/check-token",
    "apps/delete-authorization",
    "apps/delete-token",
    "apps/reset-token",
    "apps/scope-token",
  ]);
  const { tools } = await servedRun();
  const api = tools.filter((name) => name.startsWith("api."));
  assert.deepEqual(
    api.filter((name) => appCredentialTools.includes(name)),
    [],
    "tools no connected account can call",
  );
  // Every other operation is still a tool, among them a read and a mutation a person's token calls.
  assert.equal(api.length, operations.length - appOnly.length);
  for (const name of ["api.repos.get", "api.actions.createRegistrationTokenForRepo"])
    assert.ok(api.includes(name), `${name} is no longer listed`);
});

test("GitHub tool results carry no credential, except one a tool exists to mint", async () => {
  // GitHub's documented bodies, with synthetic token values and the repository marked private,
  // as GitHub sends the clone token only for private repositories. Its example omits the optional
  // `temp_download_token`, so the first runner download carries one as GitHub's schema declares.
  // A private file's `download_url` carries a `token` query, which the public example lacks.
  const recorded = JSON.parse(
    readFileSync(new URL("./tests/github-responses.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(credentialPaths(recorded), [
    "$.GET /repos/{owner}/{repo}.template_repository.temp_clone_token",
    "$.GET /repos/{owner}/{repo}.temp_clone_token",
    "$.GET /repos/{owner}/{repo}.parent.temp_clone_token",
    "$.GET /repos/{owner}/{repo}.source.temp_clone_token",
    "$.GET /user/repos[0].temp_clone_token",
    "$.GET /repos/{owner}/{repo}/actions/runners/downloads[0].temp_download_token",
    "$.GET /repos/{owner}/{repo}/contents/{path}.download_url",
    "$.GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}.secret",
    "$.POST /repos/{owner}/{repo}/actions/runners/registration-token.token",
    "$.POST /applications/{client_id}/token.token",
    "$.PATCH /applications/{client_id}/token.token",
  ]);
  // GitHub's MCP server answering `get_file_contents` for a private file too large to show, whose
  // link carries a token, and for a private directory, whose JSON listing gives each file's
  // `download_url`: GitHub's documented entries, as the server's source and tests at commit
  // df32d7ec pass them on. A client on a protocol before 2026-07-28, as Executor's is, gets no
  // output schema or structured content.
  const mcp = JSON.parse(
    readFileSync(new URL("./tests/github-mcp.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const fileTooLarge = mcp["tools/call get_file_contents large-file.bin"];
  const listing = mcp["tools/call get_file_contents lib"];
  assert.deepEqual(credentialPaths(fileTooLarge), ["$.content[0].text"]);
  assert.deepEqual(credentialPaths(listing), ["$.content[0].text"]);
  const { results, oversized, unapproved, tools, minting } = await servedRun();
  // Every tool the app lists as minting is a REST tool GitHub's description defines.
  assert.deepEqual(
    minting.filter((name) => !tools.includes(`api.${name}`)),
    [],
    "minting tools the app does not serve",
  );
  // Checking a token and resetting it answer with the same shape; only the reset mints one.
  assert.deepEqual(
    credentialPaths(results),
    ["$.api.actions.createRegistrationTokenForRepo.token", "$.api.apps.resetToken.token"],
    "only the tools that mint a credential return one",
  );
  // Everything else GitHub sent arrives unchanged.
  const without = (body: unknown) => JSON.parse(JSON.stringify(body), dropTemporary);
  const file = recorded["GET /repos/{owner}/{repo}/contents/{path}"] as Record<string, unknown>;
  assert.deepEqual(results, {
    "api.repos.get": without(recorded["GET /repos/{owner}/{repo}"]),
    "api.repos.listForAuthenticatedUser": without(recorded["GET /user/repos"]),
    "api.actions.listRunnerApplicationsForRepo": without(
      recorded["GET /repos/{owner}/{repo}/actions/runners/downloads"],
    ),
    "api.repos.getContent": {
      ...file,
      download_url: "https://raw.githubusercontent.com/octokit/octokit.rb/master/README.md",
    },
    "api.secretScanning.getAlert": omit(
      recorded["GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}"],
      "secret",
    ),
    "api.actions.createRegistrationTokenForRepo":
      recorded["POST /repos/{owner}/{repo}/actions/runners/registration-token"],
    "api.apps.checkToken": omit(recorded["POST /applications/{client_id}/token"], "token"),
    "api.apps.resetToken": recorded["PATCH /applications/{client_id}/token"],
    "mcp.get_file_contents large-file.bin": JSON.parse(
      JSON.stringify(fileTooLarge).replaceAll("?token=synthetic-raw-content-token", ""),
    ),
    "mcp.get_file_contents lib": JSON.parse(
      JSON.stringify(listing).replaceAll("?token=synthetic-raw-content-token", ""),
    ),
  });
  assert.deepEqual(
    unapproved,
    { ok: false, error: "HostToolApprovalRequired", reached: [] },
    "an unapproved minting call still waits for approval",
  );
  // The router refuses a body over its 16 MiB limit; nothing reads all of it into memory first.
  assert.equal(oversized.ok, false, "an oversized body is refused");
  assert.ok(oversized.sent > 0, "the oversized body was requested");
  assert.ok(
    oversized.sent < oversized.total,
    `read ${oversized.sent} of ${oversized.total} bytes: ${JSON.stringify(oversized.error)}`,
  );
});

test("GitHub's carried package serves without its publisher and replays exactly", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/github.json"),
    async () => {
      throw new Error("Publisher unavailable");
    },
  );
  assert.equal(response.status, 200);
  const served: unknown = await response.json();
  assert.deepEqual(served, JSON.parse(onServedFramework(JSON.stringify(githubSource))));
  const provenance = JSON.parse(bytes("provenance.json").toString());
  assert.equal(sha(bytes("published.json")), provenance.publishedSha256);
  assert.equal(sha(bytes("json")), provenance.carriedSha256);
  assert.equal(sha(bytes("patch")), provenance.patchSha256);
  const manifest = JSON.parse(
    githubSource.files.find((file) => file.path === "package.json")!.content,
  );
  assert.equal(manifest.dependencies.apps, provenance.appsVersion);
  // The reviewed one-click sign-in claim stays bound to the source served now.
  const review = reviews.entries.find((entry) => entry.entry === "github");
  assert.equal(review?.sourceSha256, catalogDocumentSha256(served));
  const original: typeof githubSource = JSON.parse(bytes("published.json").toString());
  const directory = mkdtempSync(join(tmpdir(), "github-replay-"));
  try {
    for (const file of original.files) writeFileSync(join(directory, file.path), file.content);
    execFileSync("git", ["apply", new URL("./github.patch", import.meta.url).pathname], {
      cwd: directory,
    });
    for (const file of githubSource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
