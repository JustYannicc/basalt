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
assert.deepEqual(definition.defaultScopes, ["boards:read", "boards:write"]);
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
  assert.equal(result.tools.length, 98, "The pinned package's tool list changed");
  for (const tool of result.tools) {
    assert.match(tool.path, /^\/v2(?:-experimental)?\/boards(?:\/|$)/);
    assert.doesNotMatch(tool.name, /enterprise|organization|audit|export|session|legal.hold|SCIM/i);
  }
  assert.ok(result.tools.some(tool => tool.kind === "query"));
  assert.ok(result.tools.some(tool => tool.kind === "mutation"));
  console.log(JSON.stringify({ tools: result.tools.length, skipped: result.skipped.length,
    boardOnly: true, scopes: definition.defaultScopes, specSha256: digest(specBytes),
    limits: "Compiler and host-definition checks only; native OAuth and live-provider acceptance remain unproven." }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
