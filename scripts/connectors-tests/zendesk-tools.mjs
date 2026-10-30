import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openapiToolNames } from "../../.upstream/packages/apps/dist/js/openapi.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstream = join(root, ".upstream");
const pin = JSON.parse(await readFile(join(root, "upstream.json"), "utf8"));
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim(),
  pin.commit, "Zendesk compiler proof must use the exact upstream.json pin");
const snapshotBytes = await readFile(join(root, "src/catalog/zendesk/source.json"));
const provenance = JSON.parse(await readFile(join(root, "src/catalog/zendesk/provenance.json"), "utf8"));
const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(digest(snapshotBytes), provenance.snapshotSha256, "Zendesk source snapshot differs from provenance");
assert.equal(snapshot.package, "zendesk");

const openapi = snapshot.files.find((file) => file.path === "openapi.ts");
const app = snapshot.files.find((file) => file.path === "index.ts");
assert.ok(openapi && app, "Zendesk source must carry its OpenAPI options and app router");
assert.match(app.content, /withApprovals\(/, "Imported operations must use the approval wrapper");
assert.match(app.content, /tool\.kind === "mutation" \? always\(\) : undefined/,
  "Every imported mutation must require approval");
assert.match(app.content, /fetch: marketplaceFetch\(accountOrigin\(account\), fetch\)/,
  "Marketplace headers must be limited to the saved site origin");

const requestedScopes = ["read", "write", "impersonate"];
const hostPatch = await readFile(join(root, "patches/0022-zendesk-hosted-oauth.patch"), "utf8");
const patchRegistry = JSON.parse(await readFile(join(root, "scripts/releases/patches.json"), "utf8"));
const patchDigest = digest(await readFile(join(root, "patches/0022-zendesk-hosted-oauth.patch")));
const patchEntry = patchRegistry.patches.find((entry) => entry.file === "0022-zendesk-hosted-oauth.patch");
assert.equal(patchEntry?.content_sha256, patchDigest, "Zendesk host OAuth patch differs from its registry digest");
assert.match(hostPatch, /defaultScopes: \["read", "write", "impersonate"\]/);
assert.match(hostPatch, /allowedScopes: \["read", "write", "impersonate"\]/);
assert.equal(digest(await readFile(resolve(root, ".generated/round3/zendesk-oas.yaml"))),
  provenance.openApiSpec.sha256, "Zendesk Support API spec differs from its recorded hash");

const scratch = await mkdtemp(join(tmpdir(), "basalt-zendesk-openapi-"));
try {
  const modulePath = join(scratch, "openapi.ts");
  await writeFile(modulePath, openapi.content);
  const { optionsFor } = await import(pathToFileURL(modulePath).href);
  const site = "https://customer.zendesk.com";
  const options = optionsFor(site);
  assert.equal(options.allowedOrigin, site);
  assert.equal(options.baseUrl, site);
  const result = await openapiToolNames({
    ...options,
    fetch: async (input, init) => {
      assert.equal(String(input), provenance.openApiSpec.url);
      assert.ok(init?.method === undefined || init.method === "GET",
        "OpenAPI loading must not make a provider mutation");
      return new Response(await readFile(resolve(root, ".generated/round3/zendesk-oas.yaml")), {
        headers: { "content-type": "application/yaml" },
      });
    },
  });
  assert.equal(result.skipped.length, 0, "Every operation in Zendesk's Support API document must compile");
  assert.ok(result.tools.length > 500, "The full Support API must be exposed, not only convenience wrappers");
  assert.ok(result.tools.some((tool) => tool.path === "/api/v2/users/me" && tool.kind === "query"),
    "The imported Support API must expose current-user reads");
  assert.ok(result.tools.some((tool) => tool.path === "/api/v2/tickets/{ticket_id}" && tool.kind === "mutation"),
    "The imported Support API must expose ticket updates as mutations");
  assert.ok(result.tools.some((tool) => tool.path === "/api/v2/tickets" && tool.kind === "mutation"),
    "The imported Support API must expose ticket creation as a mutation");
  console.log(JSON.stringify({
    tools: result.tools.length,
    queries: result.tools.filter((tool) => tool.kind === "query").length,
    mutations: result.tools.filter((tool) => tool.kind === "mutation").length,
    skipped: result.skipped.length,
    scopes: requestedScopes,
    siteBinding: options.allowedOrigin,
    specSha256: provenance.openApiSpec.sha256,
    providerRequests: 0,
  }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
