import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adaptProviderAppFiles, readProviderSnapshot } from "./provider-source.mjs";
import { digest } from "./provider-evidence.mjs";

const identityScopes = ["openid", "email", "profile"];

const byPath = (files, path) => {
  const file = files.find((item) => item.path === path);
  assert.ok(file, "Snapshot is missing " + path);
  return file.content;
};

function sourceLiteral(ts, node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((value) => sourceLiteral(ts, value));
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.flatMap((item) => {
        if (!ts.isPropertyAssignment(item)) return [];
        const key =
          ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)
            ? item.name.text
            : undefined;
        return key === undefined
          ? []
          : [[key, sourceLiteral(ts, item.initializer)]];
      }),
    );
  }
  if (ts.isParenthesizedExpression(node))
    return sourceLiteral(ts, node.expression);
  return undefined;
}

function property(ts, node, key) {
  assert.ok(ts.isObjectLiteralExpression(node), "Expected an object declaration");
  return node.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === key,
  );
}

function readOAuthDeclaration(ts, files, sourcePath, binding) {
  const file = ts.createSourceFile(
    sourcePath,
    byPath(files, sourcePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (item) => ts.isIdentifier(item.name) && item.name.text === binding,
    );
  assert.ok(declaration, "Cannot find provider declaration " + binding);
  const call = declaration.initializer;
  assert.ok(ts.isCallExpression(call), binding + " is not a provider call");
  const provider = call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(provider), binding + " has no options");
  const auth = property(ts, provider, "auth")?.initializer;
  assert.ok(auth, binding + " has no auth object");
  const oauth = property(ts, auth, "oauth")?.initializer;
  assert.ok(oauth && ts.isCallExpression(oauth), binding + " has no OAuth method");
  const options = oauth.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(options), binding + " has no OAuth options");
  return {
    name: sourceLiteral(ts, property(ts, provider, "name")?.initializer),
    hosts: sourceLiteral(ts, property(ts, provider, "hosts")?.initializer),
    oauth: sourceLiteral(ts, options),
  };
}

const sourceDigest = (files) =>
  digest(JSON.stringify(files.map(({ path, content }) => ({ path, content }))));

export const providerProbeFiles = (definition, accountKey) => [
  {
    path: "index.ts",
    content: [
      'import { defineApp, defineProvider, oauth2, object, query, router } from "apps";',
      "const provider = defineProvider({",
      "  name: " + JSON.stringify(definition.name) + ",",
      "  hosts: " + JSON.stringify(definition.hosts) + ",",
      "  auth: { oauth: oauth2(" + JSON.stringify(definition.oauth) + ") },",
      "});",
      "export default defineApp({ user: { accounts: { " +
        accountKey +
        ": provider.many() } } }, {",
      '  tools: router({ probe: query({ input: object({}) }, async () => ({ connected: true })) }),',
      "});",
    ].join("\n"),
  },
];

export async function loadGoogleAdminCatalog({
  upstream,
  snapshotsDirectory,
  firstPartyOAuthClientDefinitions,
}) {
  const require = createRequire(join(upstream, "package.json"));
  const ts = require("typescript-5");
  const appsVersion = JSON.parse(
    await readFile(join(upstream, "packages/apps/package.json"), "utf8"),
  ).version;
  const metadataResponse = await fetch(
    "https://accounts.google.com/.well-known/openid-configuration",
  );
  assert.equal(metadataResponse.status, 200, "Google OIDC metadata must load");
  const metadata = await metadataResponse.json();
  const googleSnapshot = await readProviderSnapshot("google", snapshotsDirectory);
  const adminSnapshot = await readProviderSnapshot("google-admin", snapshotsDirectory);
  const normal = readOAuthDeclaration(
    ts,
    googleSnapshot.snapshot.files,
    "provider.ts",
    "google",
  );
  const admin = readOAuthDeclaration(
    ts,
    adminSnapshot.snapshot.files,
    "index.ts",
    "googleAdmin",
  );
  const googleClient = firstPartyOAuthClientDefinitions.find(
    (definition) => definition.id === "google",
  );
  assert.ok(googleClient, "The reviewed Google client is missing");
  const adminScopes = admin.oauth.scopes.filter(
    (scope) => !identityScopes.includes(scope),
  );

  assert.equal(normal.name, "Google");
  assert.equal(admin.name, "Google Admin");
  assert.deepEqual(admin.oauth.scopes.slice(0, 3), identityScopes);
  assert.equal(admin.oauth.scopes.length, 21);
  assert.equal(adminScopes.length, 18);
  assert.ok(
    adminScopes.every((scope) =>
      scope.startsWith("https://www.googleapis.com/auth/admin."),
    ),
    "Every non-identity Google Admin scope must use the Admin SDK namespace",
  );
  assert.equal(admin.oauth.discover, metadata.issuer);
  assert.equal(normal.oauth.discover, metadata.issuer);
  assert.equal(googleClient.server.authorizationUrl, metadata.authorization_endpoint);
  assert.equal(googleClient.server.tokenUrl, metadata.token_endpoint);
  assert.ok(
    metadata.token_endpoint_auth_methods_supported.includes(
      googleClient.tokenEndpointAuthMethod,
    ),
    "Google OIDC metadata must support the shared client's token auth method",
  );
  assert.equal(googleClient.tokenEndpointAuthMethod, "client_secret_post");
  assert.deepEqual(googleClient.defaultScopes, identityScopes);
  assert.ok(
    adminScopes.every((scope) => googleClient.allowedScopes.includes(scope)),
    "The shared Google client must allow every official Admin scope",
  );
  assert.deepEqual(
    new Set(
      googleClient.allowedScopes.filter((scope) =>
        scope.startsWith("https://www.googleapis.com/auth/admin."),
      ),
    ),
    new Set(adminScopes),
    "The shared client must allow exactly the Admin scopes requested by this app",
  );
  assert.ok(
    adminScopes.every((scope) => !googleClient.defaultScopes.includes(scope)),
    "Admin scopes must stay out of ordinary Google defaults",
  );
  assert.ok(
    normal.oauth.scopes.every((scope) => googleClient.allowedScopes.includes(scope)),
    "The existing Google app's normal scopes must remain allowed",
  );
  assert.ok(
    normal.oauth.scopes.every((scope) => !adminScopes.includes(scope)),
    "The existing Google app must not request Admin scopes",
  );
  assert.ok(admin.hosts.includes("admin.googleapis.com"));
  assert.ok(admin.hosts.includes("openidconnect.googleapis.com"));

  const adminFiles = adaptProviderAppFiles(
    adminSnapshot.snapshot.files,
    appsVersion,
    "google-admin",
  ).files;
  return {
    appsVersion,
    metadata,
    googleClient,
    identityScopes,
    adminScopes,
    normal,
    admin,
    adminFiles,
    snapshots: {
      google: {
        package: googleSnapshot.snapshot.package,
        sha256: digest(googleSnapshot.bytes),
        sourceSha256: sourceDigest(googleSnapshot.snapshot.files),
      },
      googleAdmin: {
        package: adminSnapshot.snapshot.package,
        sha256: digest(adminSnapshot.bytes),
        sourceSha256: sourceDigest(adminSnapshot.snapshot.files),
      },
    },
  };
}
