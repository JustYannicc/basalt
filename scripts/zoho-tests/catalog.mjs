import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deploymentPayload, digest } from "./evidence.mjs";

export const ZOHO_SNAPSHOT_PATH = process.env.ZOHO_SNAPSHOT_PATH ?? "";
export const ZOHO_SNAPSHOT_SHA256 = "3d9311639b4a1004e68e73d001c1d238aa2e420dc030173f706de65f75adbdb2";
export const ZOHO_CLIENT_ID = "synthetic-zoho-proof-client";
export const ZOHO_CLIENT_SECRET = "synthetic-zoho-proof-secret";
export const ZOHO_SCOPES = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
  "ZohoCRM.users.ALL",
  "ZohoCRM.org.ALL",
  "ZohoCRM.bulk.ALL",
  "ZohoCRM.coql.READ",
  "ZohoCRM.notifications.READ",
  "ZohoCRM.notifications.CREATE",
  "ZohoCRM.notifications.UPDATE",
  "ZohoCRM.notifications.DELETE",
  "ZohoCRM.features.READ",
  "ZohoCRM.send_mail.all.CREATE",
  "ZohoCRM.Files.CREATE",
  "ZohoCRM.Files.READ",
];

const regionIds = ["us", "eu", "in", "au", "jp", "ca", "sa", "cn"];

function replaceExpected(content, from, to, expectedCount, path) {
  const count = content.split(from).length - 1;
  assert.equal(count, expectedCount, path + " origin occurrence count changed for " + from);
  return { content: content.replaceAll(from, to), count };
}

function replaceQuotedOrigin(content, from, to, path) {
  const escaped = from.replaceAll(".", "\\.");
  const pattern = new RegExp(escaped + '(?=["\`])', "g");
  const matches = [...content.matchAll(pattern)];
  assert.equal(matches.length, 1, path + " must contain one exact quoted origin " + from);
  return { content: content.replace(pattern, to), count: matches.length };
}

function officialRegions(openapiSource) {
  const matches = [...openapiSource.matchAll(
    /\b(us|eu|in|au|jp|ca|sa|cn): \{ accounts: "(https:\/\/[^"]+)", api: "(https:\/\/[^"]+)" \}/g,
  )];
  assert.equal(matches.length, 8, "Official Zoho source must name eight regional OAuth and API origins");
  const result = matches.map(match => ({
    id: match[1],
    accounts: match[2],
    api: match[3],
  }));
  assert.deepEqual(result.map(region => region.id), regionIds);
  return result;
}

function officialScopes(indexSource) {
  const block = /const scopes = \[([\s\S]*?)\];/.exec(indexSource)?.[1];
  assert.ok(block, "Official Zoho source must declare OAuth scopes");
  const scopes = [...block.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scopes, ZOHO_SCOPES, "Official Zoho OAuth scope set changed");
  return scopes;
}

/** Match the eight live hosted client definitions against the official app's regional metadata. */
export function matchHostedRegionalClients(regions, scopes, definitions) {
  const clients = definitions.filter(definition => definition.id.startsWith("zoho-"));
  assert.equal(clients.length, 8, "Hosted runtime must expose exactly eight Zoho regional clients");
  for (const region of regions) {
    const client = clients.find(definition => definition.id === "zoho-" + region.id);
    assert.ok(client, "Hosted runtime is missing Zoho region " + region.id);
    assert.equal(
      client.server.authorizationUrl,
      region.accounts + "/oauth/v2/auth",
      "Hosted Zoho authorization URL differs from the official app for " + region.id,
    );
    assert.equal(
      client.server.tokenUrl,
      region.accounts + "/oauth/v2/token",
      "Hosted Zoho token URL differs from the official app for " + region.id,
    );
    assert.equal(
      client.server.revocationUrl,
      region.accounts + "/oauth/v2/token/revoke",
      "Hosted Zoho revocation URL differs from the official app for " + region.id,
    );
    assert.deepEqual(client.server.authorizationParams, { access_type: "offline", prompt: "consent" });
    assert.equal(client.server.scopeSeparator, ",");
    assert.equal(client.server.grantedScopeSeparator, ",");
    assert.equal(client.tokenEndpointAuthMethod, "client_secret_post");
    assert.deepEqual(client.defaultScopes, scopes);
    assert.deepEqual(client.placement, {
      hosts: [new URL(region.api).host],
      scheme: "Zoho-oauthtoken",
    });
  }
  return clients.map(client => client.id);
}

/** Load the untouched official snapshot and make only documented loopback and SDK-version adaptations. */
export async function loadZohoCatalogSource({
  snapshotPath = ZOHO_SNAPSHOT_PATH,
  expectedSnapshotSha256 = ZOHO_SNAPSHOT_SHA256,
  providerOrigin,
  upstream,
  hostedDefinitions,
}) {
  const origin = new URL(providerOrigin);
  assert.equal(origin.protocol, "http:", "Local provider fixture must use loopback HTTP");
  assert.equal(origin.hostname, "127.0.0.1", "Only the documented loopback origin is allowed");
  assert.ok(Number(origin.port) > 0, "Provider fixture must bind an explicit loopback port");
  assert.equal(origin.pathname, "/", "Provider fixture origin must not contain a path");
  const raw = await readFile(snapshotPath);
  const sourceHash = digest(raw);
  assert.equal(sourceHash, expectedSnapshotSha256, "Official Zoho snapshot hash changed");
  const snapshot = JSON.parse(raw.toString("utf8"));
  assert.equal(snapshot.package, "@executor.sh/zoho");
  assert.ok(Array.isArray(snapshot.files), "Official Zoho snapshot has no file list");
  const originalFiles = snapshot.files.map(file => ({
    path: file.path,
    bytes: Buffer.byteLength(file.content),
    sha256: digest(file.content),
  }));
  const files = snapshot.files.map(file => ({ ...file }));
  const file = path => {
    const found = files.find(candidate => candidate.path === path);
    assert.ok(found, "Official Zoho snapshot is missing " + path);
    return found;
  };

  const openapi = file("openapi.ts");
  const regions = officialRegions(openapi.content);
  const scopes = officialScopes(file("index.ts").content);
  const hostedClients = matchHostedRegionalClients(regions, scopes, hostedDefinitions);
  const methodMap = file("index.ts").content;
  for (const region of regions) {
    const method = "oauth" + region.id[0].toUpperCase() + region.id.slice(1);
    assert.ok(
      methodMap.includes(method + ': "' + region.id + '"'),
      "Official Zoho health method does not map to hosted region " + region.id,
    );
  }

  const installedApps = await import(pathToFileURL(join(upstream, "e2e/support/apps-release.ts")).href);
  const appsVersion = installedApps.appsVersion;
  assert.match(appsVersion ?? "", /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, "Installed apps SDK version is invalid");
  const manifest = file("package.json");
  const manifestValue = JSON.parse(manifest.content);
  assert.equal(manifestValue.name, "@executor.sh/zoho");
  assert.equal(manifestValue.dependencies?.apps, "0.0.1-beta.100");
  const sdkFrom = manifestValue.dependencies.apps;
  const sdkTo = JSON.stringify(appsVersion);
  const sdkReplacement = replaceExpected(
    manifest.content,
    '"apps": "' + sdkFrom + '"',
    '"apps": ' + sdkTo,
    1,
    "package.json",
  );
  manifest.content = sdkReplacement.content;
  assert.equal(JSON.parse(manifest.content).dependencies.apps, appsVersion);

  const originRewrites = [];
  const originPairs = regions.flatMap(region => [
    { region, oldOrigin: region.accounts },
    { region, oldOrigin: region.api },
  ]);
  for (const { region, oldOrigin } of originPairs) {
    const replacement = replaceQuotedOrigin(
      openapi.content,
      oldOrigin,
      origin.origin,
      "openapi.ts",
    );
    openapi.content = replacement.content;
    originRewrites.push({ path: "openapi.ts", from: oldOrigin, to: origin.origin, count: replacement.count });
  }
  const document = file("document.json");
  const documentValue = JSON.parse(document.content);
  assert.equal(documentValue.servers?.[0]?.url, "https://www.zohoapis.com/crm/v8");
  const serverEntry = '"servers":[{"url":' + JSON.stringify(documentValue.servers[0].url) + "}]";
  const rewrittenServerEntry = '"servers":[{"url":'
    + JSON.stringify(origin.origin + "/crm/v8") + "}]";
  const documentReplacement = replaceExpected(
    document.content,
    serverEntry,
    rewrittenServerEntry,
    1,
    "document.json",
  );
  document.content = documentReplacement.content;
  originRewrites.push({
    path: "document.json",
    from: documentValue.servers[0].url,
    to: origin.origin + "/crm/v8",
    count: documentReplacement.count,
  });

  const payload = deploymentPayload(files);
  return {
    packageName: snapshot.package,
    snapshot: {
      path: snapshotPath,
      bytes: raw.byteLength,
      sha256: sourceHash,
      files: originalFiles,
    },
    files,
    payload,
    officialRegions: regions.map(region => ({
      id: region.id,
      accountsOrigin: region.accounts,
      apiOrigin: region.api,
    })),
    hostedRegionalClients: hostedClients,
    sdkAdaptation: { path: "package.json", from: sdkFrom, to: appsVersion, occurrences: 1 },
    loopbackOriginRewrites: originRewrites,
    providerOrigin: origin.origin,
    scopes,
  };
}

/** Clone the real EU hosted client into the documented local-only test authorization server. */
export function localZohoOAuthDefinition(hostedDefinitions, providerOrigin) {
  const reviewed = hostedDefinitions.find(definition => definition.id === "zoho-eu");
  assert.ok(reviewed, "Prepared hosted runtime is missing its EU Zoho client");
  const fixture = structuredClone(reviewed);
  const previous = {
    id: fixture.id,
    authorizationUrl: fixture.server.authorizationUrl,
    tokenUrl: fixture.server.tokenUrl,
    revocationUrl: fixture.server.revocationUrl,
    hosts: [...fixture.placement.hosts],
  };
  fixture.id = "zoho-local-proof";
  fixture.label = "Zoho CRM synthetic local proof";
  fixture.server.authorizationUrl = providerOrigin + "/oauth/v2/auth";
  fixture.server.tokenUrl = providerOrigin + "/oauth/v2/token";
  fixture.server.revocationUrl = providerOrigin + "/oauth/v2/token/revoke";
  fixture.placement.hosts = [new URL(providerOrigin).host];
  assert.deepEqual(fixture.defaultScopes, ZOHO_SCOPES);
  assert.equal(fixture.placement.scheme, "Zoho-oauthtoken");
  return {
    definition: fixture,
    adaptation: {
      fromClient: previous.id,
      testClientId: fixture.id,
      authorizationUrl: { from: previous.authorizationUrl, to: fixture.server.authorizationUrl },
      tokenUrl: { from: previous.tokenUrl, to: fixture.server.tokenUrl },
      revocationUrl: { from: previous.revocationUrl, to: fixture.server.revocationUrl },
      placementHosts: { from: previous.hosts, to: fixture.placement.hosts },
      scopesPreserved: true,
      schemePreserved: fixture.placement.scheme,
    },
  };
}
