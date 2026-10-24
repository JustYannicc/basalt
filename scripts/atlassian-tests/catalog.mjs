import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scopes = [
  "offline_access",
  "read:jira-work",
  "read:confluence-content.all",
  "search:confluence",
];

/** Load the app JSON from the same local feed handler clients use. */
export async function loadAtlassianCatalogSource(root, expectedHash, providerOrigin) {
  const sourcePath = join(root, "src/catalog/atlassian/source.json");
  const rawSource = await readFile(sourcePath);
  const sourceHash = createHash("sha256").update(rawSource).digest("hex");
  assert.equal(sourceHash, expectedHash, "Atlassian catalog source does not match the expected frozen snapshot hash");
  const sourceSnapshot = JSON.parse(rawSource.toString("utf8"));
  const provenance = JSON.parse(await readFile(join(root, "src/catalog/atlassian/provenance.json"), "utf8"));
  assert.equal(provenance.repository, "https://github.com/UsefulSoftwareCo/executor");
  assert.equal(provenance.revision, "8e7ce4b6fedd6a4dfc8940a9c13dbd7e658081aa");
  assert.equal(provenance.directory, "playground/demo-apps/atlassian");
  assert.equal(provenance.snapshotSha256, sourceHash);
  for (const file of sourceSnapshot.files)
    assert.equal(createHash("sha256").update(file.content).digest("hex"), provenance.files[file.path],
      `Atlassian source file ${file.path} differs from its immutable upstream capture`);
  const { handleCatalog } = await import(pathToFileURL(join(root, "src/catalog/worker.ts")).href);
  const origin = "http://catalog-proof.invalid";
  const fetcher = async () => new Response(JSON.stringify({ version: 1, apps: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const ready = { google: false, github: false, atlassian: true };
  const index = await handleCatalog(new Request(`${origin}/catalog/index.json`), fetcher, ready);
  assert.equal(index.status, 200, "Local catalog feed is unavailable");
  const feed = await index.json();
  const entry = feed.apps.find((app) => app.id === "atlassian");
  assert.ok(entry, "Local catalog does not contain app id atlassian");
  assert.equal(entry.package, "@executor.sh/atlassian");
  assert.equal(entry.source, "apps/atlassian.json");

  const response = await handleCatalog(new Request(`${origin}/catalog/${entry.source}`), fetcher, ready);
  assert.equal(response.status, 200, "Atlassian source is not served by the local catalog");
  const source = await response.json();
  assert.deepEqual(source, sourceSnapshot, "Feed source differs from the reviewed catalog snapshot");
  assert.equal(source.package, "@executor.sh/atlassian");
  assert.deepEqual(source.files.map((file) => file.path).sort(), ["index.ts", "package.json"]);
  const manifest = JSON.parse(source.files.find((file) => file.path === "package.json").content);
  assert.equal(manifest.dependencies?.apps, "0.0.1-beta.103", "Catalog app SDK pin changed");

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
