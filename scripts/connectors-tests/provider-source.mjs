import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const byPath = (files, path) => {
  const file = files.find((item) => item.path === path);
  assert.ok(file, `Snapshot is missing ${path}`);
  return file.content;
};

const replaceExact = (content, before, after, label, expected = 1) => {
  const count = content.split(before).length - 1;
  assert.equal(count, expected, `${label}: expected ${expected} source occurrence(s), found ${count}`);
  return {
    content: content.replaceAll(before, after),
    substitution: { label, from: before, to: after, occurrences: count },
  };
};

const recordFile = (files, path, content) => {
  const index = files.findIndex((file) => file.path === path);
  assert.notEqual(index, -1, `Snapshot is missing ${path}`);
  files[index] = { ...files[index], content };
};

/** Reads one saved, official package snapshot without network access. */
export async function readProviderSnapshot(providerId, snapshotsDirectory) {
  const path = join(snapshotsDirectory, `${providerId}.json`);
  const bytes = await readFile(path);
  const snapshot = JSON.parse(bytes.toString("utf8"));
  assert.equal(snapshot.package, `@executor.sh/${providerId}`);
  assert.ok(Array.isArray(snapshot.files));
  return { snapshot, bytes, path };
}

function objectLiteral(ts, node) {
  assert.ok(ts.isObjectLiteralExpression(node), "Expected a source object literal");
  return Object.fromEntries(node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    return key === undefined ? [] : [[key, literal(ts, property.initializer)]];
  }));
}

function literal(ts, node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((value) => literal(ts, value));
  if (ts.isObjectLiteralExpression(node)) return objectLiteral(ts, node);
  if (ts.isParenthesizedExpression(node)) return literal(ts, node.expression);
  return undefined;
}

/** Compares the official app's parsed OAuth declaration to the host first-party record. */
export function matchFirstPartyOAuth(providerId, files, upstream, definitions) {
  const require = createRequire(join(upstream, "package.json"));
  const ts = require("typescript-5");
  const source = byPath(files, "index.ts");
  const file = ts.createSourceFile(`${providerId}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = file.statements.find((item) =>
    ts.isVariableStatement(item) && item.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === providerId,
    ),
  );
  const declaration = statement?.declarationList.declarations.find((item) =>
    ts.isIdentifier(item.name) && item.name.text === providerId,
  );
  const call = declaration?.initializer;
  assert.ok(call && ts.isCallExpression(call), `Cannot find ${providerId} provider declaration`);
  const provider = call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(provider), `${providerId} provider options are not an object`);
  const property = (node, key) => node.properties.find((item) =>
    ts.isPropertyAssignment(item) && item.name.getText(file) === key,
  );
  const auth = property(provider, "auth")?.initializer;
  assert.ok(auth && ts.isObjectLiteralExpression(auth), `${providerId} provider has no auth object`);
  const oauth = property(auth, "oauth")?.initializer;
  assert.ok(oauth && ts.isCallExpression(oauth), `${providerId} provider has no OAuth method`);
  const options = oauth.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(options), `${providerId} oauth2 options are not an object`);
  const hosts = property(provider, "hosts")?.initializer;
  assert.ok(hosts, `${providerId} provider has no host declaration`);
  const app = { hosts: literal(ts, hosts), oauth: objectLiteral(ts, options) };
  const firstParty = definitions.find((item) => item.id === providerId);
  assert.ok(firstParty, `Host first-party OAuth definition for ${providerId} is missing`);
  assert.equal(app.oauth.authorizationUrl, firstParty.server.authorizationUrl);
  assert.equal(app.oauth.tokenUrl, firstParty.server.tokenUrl);
  assert.equal(app.oauth.revocationUrl ?? undefined, firstParty.server.revocationUrl);
  assert.equal(app.oauth.tokenEndpointAuthMethod, firstParty.tokenEndpointAuthMethod);
  assert.deepEqual(app.oauth.scopes, firstParty.defaultScopes);
  assert.deepEqual(app.hosts, firstParty.placement.hosts);
  return firstParty;
}

/** Changes only the `apps` dependency so the prepared local registry can compile this snapshot. */
export function adaptProviderAppFiles(inputFiles, appsVersion, providerId) {
  const files = inputFiles.map((file) => ({ ...file }));
  const packageFile = byPath(files, "package.json");
  const originalAppsVersion = JSON.parse(packageFile).dependencies?.apps;
  assert.ok(originalAppsVersion, `${providerId} snapshot does not declare apps`);
  if (originalAppsVersion !== appsVersion) {
    const replaced = replaceExact(
      packageFile,
      `"apps": "${originalAppsVersion}"`,
      `"apps": "${appsVersion}"`,
      `${providerId}: local apps release`,
    );
    recordFile(files, "package.json", replaced.content);
  }
  return { files, packageVersion: { originalApps: originalAppsVersion, runtimeApps: appsVersion } };
}

/** Copies official app files and rewrites only request origins needed by a local-only runtime. */
export function prepareLocalMockSource(inputFiles, providerId, fixture, appsVersion) {
  const adapted = adaptProviderAppFiles(inputFiles, appsVersion, providerId);
  const files = adapted.files;
  const substitutions = [];
  const replaceFile = (path, before, after, label, expected = 1) => {
    const current = byPath(files, path);
    const replaced = replaceExact(current, before, after, label, expected);
    recordFile(files, path, replaced.content);
    substitutions.push(replaced.substitution);
  };
  const origin = fixture.origin;
  const host = fixture.host;
  if (providerId === "gitlab") {
    replaceFile("index.ts", 'hosts: ["gitlab.com"]', `hosts: [${JSON.stringify(host)}]`, "gitlab: provider host");
    replaceFile("index.ts", 'https://gitlab.com/oauth/authorize', `${origin}/oauth/authorize`, "gitlab: OAuth authorization origin");
    replaceFile("index.ts", 'https://gitlab.com/oauth/token', `${origin}/oauth/token`, "gitlab: OAuth token origin");
    replaceFile("index.ts", 'https://gitlab.com/oauth/revoke', `${origin}/oauth/revoke`, "gitlab: OAuth revocation origin");
    replaceFile("index.ts", 'https://gitlab.com/api/v4/user', `${origin}/api/v4/user`, "gitlab: health API origin");
    replaceFile("openapi.ts",
      'https://gitlab.com/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v3.yaml',
      `${origin}/spec/gitlab.json`, "gitlab: OpenAPI document origin");
    replaceFile("openapi.ts", '"https://gitlab.com"', JSON.stringify(origin), "gitlab: API origins", 2);
  } else {
    replaceFile("index.ts", 'hosts: ["api.miro.com"]', `hosts: [${JSON.stringify(host)}]`, "miro: provider host");
    replaceFile("index.ts", 'https://miro.com/oauth/authorize', `${origin}/oauth/authorize`, "miro: OAuth authorization origin");
    replaceFile("index.ts", 'https://api.miro.com/v1/oauth/token', `${origin}/v1/oauth/token`, "miro: OAuth token origin");
    replaceFile("index.ts", 'https://api.miro.com/v1/oauth-token', `${origin}/v1/oauth-token`, "miro: health API origin");
    replaceFile("openapi.ts",
      'https://raw.githubusercontent.com/miroapp/api-clients/39161f97cee3f887f5f67cf4a003ce93b3a6903b/packages/generator/spec.json',
      `${origin}/spec/miro.json`, "miro: OpenAPI document origin");
    replaceFile("openapi.ts", '"https://api.miro.com"', JSON.stringify(origin), "miro: allowed API origin");
  }
  const index = byPath(files, "index.ts");
  const openapi = byPath(files, "openapi.ts");
  assert.ok(!/https:\/\/(?:gitlab\.com|miro\.com|api\.miro\.com|raw\.githubusercontent\.com)/.test(index + openapi),
    `${providerId} local source retains a live provider request origin`);
  return { files, packageVersion: adapted.packageVersion, substitutions };
}
