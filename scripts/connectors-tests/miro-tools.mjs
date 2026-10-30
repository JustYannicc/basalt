import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openapiToolNames } from "../../.upstream/packages/apps/dist/js/openapi.js";
import { firstPartyOAuthClientDefinitions } from "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts";
import { matchFirstPartyOAuth } from "./provider-source.mjs";

// Compile the carried package against its full pinned API document without provider requests.
const root = fileURLToPath(new URL("../..", import.meta.url));
assert.ok(process.argv[2], "Pass the saved Miro API document named by miro.provenance.json");
const specBytes = await readFile(resolve(process.argv[2]));
const sourceBytes = await readFile(join(root, "src/catalog/miro.json"));
const source = JSON.parse(sourceBytes.toString());
const provenance = JSON.parse(await readFile(join(root, "src/catalog/miro.provenance.json"), "utf8"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(specBytes), provenance.specSha256, "API document differs from the pinned snapshot");
assert.equal(digest(sourceBytes), provenance.carriedSha256, "Carried package differs from its provenance");
const definition = matchFirstPartyOAuth("miro", source.files, join(root, ".upstream"), firstPartyOAuthClientDefinitions);
const requestedScopes = [
  "boards:read",
  "boards:write",
  "identity:read",
  "identity:write",
  "microphone:listen",
  "screen:record",
  "team:read",
  "team:write",
  "webcam:record",
  "auditlogs:read",
  "sessions:delete",
];
assert.deepEqual(definition.defaultScopes, requestedScopes);
const generated = join(root, ".generated");
await mkdir(generated, { recursive: true });
const scratch = await mkdtemp(join(generated, "miro-tools-"));
try {
  const optionsFile = source.files.find(file => file.path === "openapi.ts");
  assert.ok(optionsFile, "Carried package has no OpenAPI options");
  const path = join(scratch, "openapi.ts");
  await writeFile(path, optionsFile.content);
  const { options } = await import(pathToFileURL(path).href);
  assert.ok(options.source.url.includes(provenance.specCommit), "API URL must use the recorded immutable revision");
  const spec = JSON.parse(specBytes.toString());
  const result = await openapiToolNames({ ...options, fetch: async () => Response.json(spec) });
  assert.equal(result.skipped.length, 0, "Every retained operation must compile");
  const excludedPaths = new Set([
    "/v1/oauth/revoke",
    "/Users",
    "/Users/{id}",
    "/Groups",
    "/Groups/{id}",
    "/ServiceProviderConfig",
    "/ResourceTypes",
    "/ResourceTypes/{resource}",
    "/Schemas",
    "/Schemas/{uri}",
    "/v2/boards/{board_id}/groups/{group_id}?",
  ]);
  const httpMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
  const expectedOperations = Object.entries(spec.paths).reduce((count, [path, item]) =>
    count + (excludedPaths.has(path) ? 0 : Object.keys(item).filter(method => httpMethods.has(method)).length), 0);
  assert.equal(result.tools.length, expectedOperations,
    "Every retained Miro API operation must compile through the pinned framework");
  assert.ok(!result.tools.some(tool => tool.path === "/v2/boards/{board_id}/groups/{group_id}?"),
    "The malformed group-delete path must be removed before import");
  for (const tool of result.tools) {
    assert.doesNotMatch(tool.path, /^\/(?:Users|Groups|ServiceProviderConfig|ResourceTypes|Schemas)(?:\/|$)/);
  }
  assert.ok(result.tools.some(tool => tool.path.startsWith("/v2/orgs/")),
    "Organization administration remains in the REST tool surface");
  assert.ok(result.tools.some(tool => tool.path === "/v2/audit/logs"),
    "Audit API remains in the REST tool surface");
  assert.ok(result.tools.some(tool => tool.path.startsWith("/v2/sessions")),
    "Session controls remain in the REST tool surface");
  assert.ok(result.tools.some(tool => tool.kind === "mutation" && tool.path.startsWith("/v2/orgs/")),
    "Administrative writes are represented as mutations");
  assert.ok(result.tools.some(tool => tool.kind === "query"));
  assert.ok(result.tools.some(tool => tool.kind === "mutation"));
  console.log(JSON.stringify({ tools: result.tools.length, skipped: result.skipped.length,
    fullRestApi: true, scopes: definition.defaultScopes, specSha256: digest(specBytes),
    limits: "Compiler and host-definition checks only; native OAuth and live-provider acceptance remain unproven." }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
