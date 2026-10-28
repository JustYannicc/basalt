import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const capture = Object.freeze({
  repository: "https://github.com/JustYannicc/executor-upstream",
  revision: "3f97ddff8ce4eb358ca942b93f34c90ccc7c948c",
  directory: "playground/demo-apps/atlassian",
  packageName: "atlassian",
  publicSnapshotSha256: "9d8def81dd017c76e171de51fdb43d10c629f87d0937597ed40010ae4316c67e",
  servedSnapshotSha256: "3a3a3a7f33107aa1139a15f73cb78d43fe6b0a45010c2b30657b1f2d0705e921",
  patchSha256: "1a4e2b438dac485b197882513b07c333765dea26f10087e36d5d972dcb9c216d",
  publicSdkVersion: "0.0.1-beta.103",
  servedSdkVersion: "0.0.1-beta.104-basalt.1",
});
const capturedPaths = ["index.ts", "package.json"];

const scopes = [
  "offline_access",
  "read:jira-work",
  "read:confluence-content.all",
  "search:confluence",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assertSourceShape(source, label) {
  assert.deepEqual(Object.keys(source).sort(), ["files", "package"], `${label} has an unexpected shape`);
  assert.equal(source.package, capture.packageName, `${label} package name changed`);
  assert.ok(Array.isArray(source.files), `${label} files must be an array`);
  assert.deepEqual(source.files.map((file) => file.path).sort(), capturedPaths, `${label} file set changed`);
  for (const file of source.files) {
    assert.deepEqual(Object.keys(file).sort(), ["content", "path"], `${label} file entry has an unexpected shape`);
    assert.equal(typeof file.content, "string", `${label} ${file.path} must contain text`);
  }
}

function assertFileHashes(source, hashes, label) {
  assert.deepEqual(Object.keys(hashes).sort(), capturedPaths, `${label} file hash set changed`);
  for (const file of source.files)
    assert.equal(sha256(file.content), hashes[file.path], `${label} ${file.path} differs from its immutable capture`);
}

/** Load the app JSON from the same local feed handler clients use. */
export async function loadAtlassianCatalogSource(root, expectedHash, providerOrigin) {
  const capturePath = join(root, "src/catalog/atlassian");
  const [rawSource, rawPublished, rawPatch, provenanceText] = await Promise.all([
    readFile(join(capturePath, "source.json")),
    readFile(join(capturePath, "source.published.json")),
    readFile(join(capturePath, "source.patch")),
    readFile(join(capturePath, "provenance.json"), "utf8"),
  ]);
  const sourceHash = sha256(rawSource);
  const publicHash = sha256(rawPublished);
  const patchHash = sha256(rawPatch);
  assert.equal(expectedHash, capture.servedSnapshotSha256,
    "Expected Atlassian snapshot hash must match the immutable served capture");
  assert.equal(sourceHash, expectedHash, "Atlassian catalog source does not match the expected frozen snapshot hash");
  assert.equal(publicHash, capture.publicSnapshotSha256, "Published Atlassian baseline hash changed");
  assert.equal(patchHash, capture.patchSha256, "Atlassian manifest patch hash changed");

  const sourceSnapshot = JSON.parse(rawSource.toString("utf8"));
  const publishedSnapshot = JSON.parse(rawPublished.toString("utf8"));
  const provenance = JSON.parse(provenanceText);
  assertSourceShape(sourceSnapshot, "Served Atlassian source");
  assertSourceShape(publishedSnapshot, "Published Atlassian source");

  assert.deepEqual(Object.keys(provenance).sort(), [
    "directory", "files", "license", "localPatch", "publicSource", "repository", "revision", "snapshotSha256",
  ], "Atlassian provenance has an unexpected shape");
  assert.deepEqual(Object.keys(provenance.publicSource).sort(), ["files", "snapshotSha256"]);
  assert.deepEqual(Object.keys(provenance.localPatch).sort(), ["path", "sha256"]);
  assert.equal(provenance.repository, capture.repository);
  assert.equal(provenance.revision, capture.revision);
  assert.equal(provenance.directory, capture.directory);
  assert.equal(provenance.license, "MIT");
  assert.equal(provenance.snapshotSha256, sourceHash);
  assert.equal(provenance.publicSource.snapshotSha256, publicHash);
  assert.equal(provenance.localPatch.path, "source.patch");
  assert.equal(provenance.localPatch.sha256, patchHash);
  assertFileHashes(sourceSnapshot, provenance.files, "Served Atlassian source");
  assertFileHashes(publishedSnapshot, provenance.publicSource.files, "Published Atlassian source");

  const sourceFiles = new Map(sourceSnapshot.files.map((file) => [file.path, file.content]));
  const publishedFiles = new Map(publishedSnapshot.files.map((file) => [file.path, file.content]));
  assert.equal(sourceFiles.get("index.ts"), publishedFiles.get("index.ts"),
    "Served Atlassian app source must match the published baseline byte for byte");
  const publishedPackage = publishedFiles.get("package.json");
  const servedPackage = sourceFiles.get("package.json");
  const publicPin = `"apps": "${capture.publicSdkVersion}"`;
  assert.equal((publishedPackage.match(new RegExp(publicPin, "g")) ?? []).length, 1,
    "Published Atlassian manifest must contain exactly one public SDK pin");
  assert.equal(servedPackage, publishedPackage.replace(publicPin, `"apps": "${capture.servedSdkVersion}"`),
    "Served Atlassian source may differ from the published baseline only by its SDK pin");

  const publishedManifest = JSON.parse(publishedPackage);
  const servedManifest = JSON.parse(servedPackage);
  assert.equal(publishedManifest.name, capture.packageName);
  assert.equal(servedManifest.name, capture.packageName);
  assert.equal(publishedManifest.dependencies?.apps, capture.publicSdkVersion);
  assert.equal(servedManifest.dependencies?.apps, capture.servedSdkVersion);
  assert.equal(rawPatch.toString("utf8"), [
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -7,7 +7,7 @@",
    '     ".": "./index.ts"',
    "   },",
    '   "dependencies": {',
    `-    "apps": "${capture.publicSdkVersion}"`,
    `+    "apps": "${capture.servedSdkVersion}"`,
    "   },",
    '   "executor": {',
    '     "title": "Atlassian"',
    "",
  ].join("\n"), "Atlassian source patch must be the standard manifest-only SDK pin diff");

  const { handleCatalog } = await import(pathToFileURL(join(root, "src/catalog/worker.ts")).href);
  const origin = "http://catalog-proof.invalid";
  const fetcher = async () => new Response(JSON.stringify({ version: 1, apps: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const index = await handleCatalog(new Request(`${origin}/catalog/index.json`), fetcher);
  assert.equal(index.status, 200, "Local catalog feed is unavailable");
  const feed = await index.json();
  const entry = feed.apps.find((app) => app.id === "atlassian");
  assert.ok(entry, "Local catalog does not contain app id atlassian");
  assert.equal(entry.package, capture.packageName);
  assert.equal(entry.source, "apps/atlassian.json");

  const response = await handleCatalog(new Request(`${origin}/catalog/${entry.source}`), fetcher);
  assert.equal(response.status, 200, "Atlassian source is not served by the local catalog");
  const source = await response.json();
  assert.deepEqual(source, sourceSnapshot, "Feed source differs from the reviewed catalog snapshot");
  assert.equal(source.package, capture.packageName);
  assert.deepEqual(source.files.map((file) => file.path).sort(), capturedPaths);
  const manifest = JSON.parse(source.files.find((file) => file.path === "package.json").content);
  assert.equal(manifest.name, source.package, "Catalog package name differs from its manifest");
  assert.equal(manifest.dependencies?.apps, capture.servedSdkVersion, "Basalt served app SDK pin changed");

  const indexFile = source.files.find((file) => file.path === "index.ts");
  const files = source.files.map((file) => ({ ...file }));
  const sourceIndex = files.find((file) => file.path === "index.ts");
  const apiUrlCount = (sourceIndex.content.match(/https:\/\/api\.atlassian\.com/g) ?? []).length;
  const authUrlCount = (sourceIndex.content.match(/https:\/\/auth\.atlassian\.com/g) ?? []).length;
  assert.ok(apiUrlCount > 0 && authUrlCount > 0, "Catalog app no longer declares the reviewed Atlassian endpoints");

  let rewritten = sourceIndex.content
    .replaceAll("https://api.atlassian.com", providerOrigin)
    .replaceAll("https://auth.atlassian.com", providerOrigin);
  const hostBlock = /(\bhosts\s*:\s*\[)([\s\S]*?)(\])/m.exec(rewritten);
  assert.ok(hostBlock, "Catalog app no longer declares its API host placement");
  let hostCount = 0;
  const host = new URL(providerOrigin).host;
  const hostValues = hostBlock[2].replace(/(["'])api\.atlassian\.com\1/g, (_match, quote) => {
    hostCount++;
    return `${quote}${host}${quote}`;
  });
  assert.ok(hostCount > 0, "Catalog app API host placement was not eligible for a loopback override");
  rewritten = rewritten.slice(0, hostBlock.index) + hostBlock[1] + hostValues + hostBlock[3]
    + rewritten.slice(hostBlock.index + hostBlock[0].length);
  assert.ok(!rewritten.includes("https://api.atlassian.com"));
  assert.ok(!rewritten.includes("https://auth.atlassian.com"));
  assert.ok(rewritten.includes('audience: "api.atlassian.com"'), "OAuth audience must remain the reviewed Atlassian value");
  for (const scope of scopes) assert.ok(rewritten.includes(`"${scope}"`), `App source omitted OAuth scope ${scope}`);
  sourceIndex.content = rewritten;
  assert.equal(files.find((file) => file.path === "package.json").content,
    source.files.find((file) => file.path === "package.json").content,
    "Endpoint override must not change the catalog package manifest");
  return {
    entry,
    packageName: source.package,
    files,
    sourceHash,
    provenance,
    overrides: { authUrls: authUrlCount, apiUrls: apiUrlCount, apiHosts: hostCount },
  };
}

/** Clone the reviewed hosted Atlassian client and change only its ID and loopback endpoints. */
export async function atlassianOAuthFixtureDefinition(upstream, providerOrigin) {
  const source = await import(pathToFileURL(join(upstream,
    "apps/hosted/server/src/implementation/first-party-oauth.ts")).href);
  const reviewed = source.firstPartyOAuthClientDefinitions.find((definition) => definition.id === "atlassian");
  assert.ok(reviewed, "Pinned hosted OAuth source does not contain its Atlassian client");
  assert.deepEqual(new Set(reviewed.defaultScopes), new Set(scopes));
  assert.deepEqual(new Set(reviewed.allowedScopes), new Set(scopes));
  assert.equal(reviewed.server.tokenRequestFormat, "json");
  assert.deepEqual(reviewed.server.authorizationParams, { audience: "api.atlassian.com", prompt: "consent" });
  const fixture = structuredClone(reviewed);
  fixture.id = "atlassian-local-proof";
  fixture.server.authorizationUrl = `${providerOrigin}/authorize`;
  fixture.server.tokenUrl = `${providerOrigin}/oauth/token`;
  fixture.placement = { ...fixture.placement, hosts: [new URL(providerOrigin).host] };
  return { definition: fixture, scopes };
}
