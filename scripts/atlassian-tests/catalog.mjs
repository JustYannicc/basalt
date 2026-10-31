import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const capture = Object.freeze({
  repository: "https://github.com/JustYannicc/executor-upstream",
  revision: "3f97ddff8ce4eb358ca942b93f34c90ccc7c948c",
  directory: "playground/demo-apps/atlassian",
  packageName: "atlassian",
  publicSnapshotSha256: "9d8def81dd017c76e171de51fdb43d10c629f87d0937597ed40010ae4316c67e",
  servedSdkVersion: "0.0.1-beta.104-basalt.1",
});
const publicPaths = ["index.ts", "package.json"];
const servedPaths = [
  "README.md",
  "api-coverage.json",
  "configuration.ts",
  "index.ts",
  "openapi.ts",
  "package.json",
  "provider.ts",
  "queries.ts",
  "transport.ts",
];
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assertSource(source, paths, hashes) {
  assert.deepEqual(Object.keys(source).sort(), ["files", "package"]);
  assert.equal(source.package, capture.packageName);
  assert.deepEqual(source.files.map((file) => file.path).sort(), paths);
  assert.deepEqual(Object.keys(hashes).sort(), paths);
  for (const file of source.files) {
    assert.deepEqual(Object.keys(file).sort(), ["content", "path"]);
    assert.equal(typeof file.content, "string");
    assert.equal(sha256(file.content), hashes[file.path], `Captured ${file.path} hash differs`);
  }
}

/** Replay the full carry from its immutable public baseline before endpoint overrides. */
async function verifyPatch(published, source, patch) {
  const scratch = await mkdtemp(join(tmpdir(), "atlassian-patch-proof-"));
  try {
    for (const file of published.files) await writeFile(join(scratch, file.path), file.content);
    const patchPath = join(scratch, "source.patch");
    await writeFile(patchPath, patch);
    execFileSync("git", ["apply", "--no-index", "--unsafe-paths", patchPath], {
      cwd: scratch,
      stdio: "pipe",
    });
    for (const file of source.files)
      assert.equal(
        await readFile(join(scratch, file.path), "utf8"),
        file.content,
        `Patch does not reproduce ${file.path}`,
      );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Load the real catalog feed. Override only vendor endpoints and the provider host. */
export async function loadAtlassianCatalogSource(root, expectedHash, providerOrigin) {
  const directory = join(root, "src/catalog/atlassian");
  const [rawSource, rawPublished, rawPatch, provenanceText] = await Promise.all([
    readFile(join(directory, "source.json")),
    readFile(join(directory, "source.published.json")),
    readFile(join(directory, "source.patch")),
    readFile(join(directory, "provenance.json"), "utf8"),
  ]);
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  const sourceHash = sha256(rawSource);
  assert.equal(
    sourceHash,
    expectedHash,
    "Atlassian source differs from the externally frozen hash",
  );
  assert.equal(sha256(rawPublished), capture.publicSnapshotSha256);
  const snapshot = JSON.parse(rawSource);
  const published = JSON.parse(rawPublished);
  const provenance = JSON.parse(provenanceText);
  for (const key of ["repository", "revision", "directory"])
    assert.equal(provenance[key], capture[key]);
  assert.equal(provenance.license, "MIT");
  assert.equal(provenance.snapshotSha256, sourceHash);
  assert.equal(provenance.publicSource.snapshotSha256, capture.publicSnapshotSha256);
  assert.equal(provenance.localPatch.path, "source.patch");
  assert.equal(provenance.localPatch.sha256, sha256(rawPatch));
  assertSource(snapshot, servedPaths, provenance.files);
  assertSource(published, publicPaths, provenance.publicSource.files);
  await verifyPatch(published, snapshot, rawPatch);
  const { handleCatalog } = await import(pathToFileURL(join(root, "src/catalog/worker.ts")).href);
  const origin = "http://catalog-proof.invalid";
  const fetcher = async () => Response.json({ version: 1, apps: [] });
  const feed = await (
    await handleCatalog(new Request(`${origin}/catalog/index.json`), fetcher)
  ).json();
  const entry = feed.apps.find((app) => app.id === "atlassian");
  assert.equal(entry?.package, capture.packageName);
  assert.equal(entry.source, "apps/atlassian.json");
  const response = await handleCatalog(new Request(`${origin}/catalog/${entry.source}`), fetcher);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot, "Feed differs from captured source");
  const files = structuredClone(snapshot.files);
  const manifest = JSON.parse(files.find((file) => file.path === "package.json").content);
  assert.equal(manifest.name, capture.packageName);
  assert.equal(manifest.dependencies.apps, capture.servedSdkVersion);
  let apiUrls = 0,
    authUrls = 0,
    apiHosts = 0;
  for (const file of files.filter((file) => file.path.endsWith(".ts"))) {
    apiUrls += (file.content.match(/https:\/\/api\.atlassian\.com/g) ?? []).length;
    authUrls += (file.content.match(/https:\/\/auth\.atlassian\.com/g) ?? []).length;
    file.content = file.content
      .replaceAll("https://api.atlassian.com", providerOrigin)
      .replaceAll("https://auth.atlassian.com", providerOrigin);
  }
  const provider = files.find((file) => file.path === "provider.ts");
  provider.content = provider.content.replace(
    /(hosts:\s*\[)"api\.atlassian\.com"(\])/,
    (_match, before, after) => {
      apiHosts++;
      return `${before}${JSON.stringify(new URL(providerOrigin).host)}${after}`;
    },
  );
  assert.ok(apiUrls > 0 && authUrls > 0 && apiHosts === 1);
  assert.ok(provider.content.includes('audience: "api.atlassian.com"'));
  const metadataFile = files.find((file) => file.path === "api-coverage.json");
  const coverage = JSON.parse(metadataFile.content);
  for (const [name, api] of Object.entries(coverage)) {
    assert.equal(api.url, provenance.capabilities.apis[name].url);
    assert.equal(api.sha256, provenance.capabilities.apis[name].sha256);
    api.url = `${providerOrigin}/openapi/${name}.json`;
  }
  metadataFile.content = JSON.stringify(coverage);
  const negativeControl = process.env.ATLASSIAN_APPROVAL_NEGATIVE_CONTROL === "1";
  if (negativeControl) {
    const index = files.find((file) => file.path === "index.ts");
    const original = 'import { always } from "apps/operations/approval";';
    assert.ok(index.content.includes(original));
    index.content = index.content.replace(
      original,
      'import { never as always } from "apps/operations/approval";',
    );
  }
  return {
    entry,
    packageName: snapshot.package,
    files,
    sourceHash,
    provenance,
    overrides: { apiUrls, authUrls, apiHosts, openapiUrls: Object.keys(coverage).length },
  };
}

/** Clone the supported hosted client without changing its requested scopes. */
export async function atlassianOAuthFixtureDefinition(upstream, providerOrigin, scopes) {
  const source = await import(
    pathToFileURL(join(upstream, "apps/hosted/server/src/implementation/first-party-oauth.ts")).href
  );
  const reviewed = source.firstPartyOAuthClientDefinitions.find(
    (definition) => definition.id === "atlassian",
  );
  assert.ok(reviewed);
  assert.deepEqual(new Set(reviewed.defaultScopes), new Set(scopes));
  assert.deepEqual(new Set(reviewed.allowedScopes), new Set(scopes));
  assert.equal(reviewed.server.tokenRequestFormat, "json");
  assert.deepEqual(reviewed.server.authorizationParams, {
    audience: "api.atlassian.com",
    prompt: "consent",
  });
  const definition = structuredClone(reviewed);
  definition.id = "atlassian-local-proof";
  definition.server.authorizationUrl = `${providerOrigin}/authorize`;
  definition.server.tokenUrl = `${providerOrigin}/oauth/token`;
  definition.placement = { ...definition.placement, hosts: [new URL(providerOrigin).host] };
  return { definition, scopes };
}
