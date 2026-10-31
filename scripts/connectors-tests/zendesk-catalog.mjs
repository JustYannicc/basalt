import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exactReplace = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `Expected one ${label} in the catalog source, found ${count}`);
  return source.replace(before, after);
};

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/** Build the owned Worker entrypoint and serve it with workerd through Miniflare. */
export async function startZendeskCatalogWorker({ root, upstream, directory, marketplace }) {
  const require = createRequire(join(upstream, "package.json"));
  const esbuild = require("esbuild");
  const { Miniflare } = await import(require.resolve("miniflare"));
  const bundle = join(directory, "catalog-worker.mjs");
  await esbuild.build({
    entryPoints: [join(root, "src/catalog/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: bundle,
    logLevel: "silent",
  });
  const miniflare = new Miniflare({
    name: "basalt-zendesk-catalog-proof",
    scriptPath: bundle,
    modulesRoot: directory,
    modules: true,
    host: "127.0.0.1",
    port: await freePort(),
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ZENDESK_MARKETPLACE_ORGANIZATION_ID: marketplace.organizationId,
      ZENDESK_MARKETPLACE_APP_ID: marketplace.appId,
    },
  });
  let address;
  try {
    address = await miniflare.ready;
  } catch (error) {
    await miniflare.dispose();
    throw error;
  }
  return {
    origin: address.origin,
    async stop() {
      await miniflare.dispose();
    },
  };
}

/** Read the bytes the catalog Worker serves, verify the source snapshot, then make explicit test-only endpoint overrides. */
export async function loadZendeskCatalogSource({ root, catalogOrigin, directory, sites, marketplace,
  candidateSha, upstreamPin, carriedPatches = [] }) {
  const route = new URL("/catalog/apps/zendesk.json", catalogOrigin);
  const response = await fetch(route, { redirect: "manual", headers: { accept: "application/json" } });
  assert.equal(response.status, 200, "Catalog Worker did not serve Zendesk source over HTTP");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  const servedBytes = Buffer.from(await response.arrayBuffer());
  const source = JSON.parse(servedBytes.toString("utf8"));
  assert.equal(source.package, "zendesk");

  const snapshotPath = join(root, "src/catalog/zendesk/source.json");
  const provenancePath = join(root, "src/catalog/zendesk/provenance.json");
  const [snapshotBytes, provenanceBytes, workerBytes] = await Promise.all([
    readFile(snapshotPath),
    readFile(provenancePath),
    readFile(join(root, "src/catalog/worker.ts")),
  ]);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const snapshotProvenance = JSON.parse(provenanceBytes.toString("utf8"));
  assert.equal(sha256(snapshotBytes), snapshotProvenance.snapshotSha256, "Zendesk snapshot provenance hash changed");
  assert.equal(source.package, snapshotProvenance.package);
  assert.deepEqual(source.files.map(({ path }) => path).sort(), snapshot.files.map(({ path }) => path).sort());
  for (const path of ["README.md", "icon.ts", "index.ts", "openapi.ts", "package.json"]) {
    const servedFile = source.files.find((file) => file.path === path);
    assert.ok(servedFile, `Catalog Worker omitted ${path}`);
    assert.equal(
      sha256(servedFile.content),
      snapshotProvenance.catalogFileSha256[path],
      `Catalog Worker changed the reviewed Zendesk ${path}`,
    );
  }

  const configuration = source.files.find((file) => file.path === "configuration.ts");
  assert.ok(configuration, "Catalog Worker omitted Zendesk operator configuration");
  const configMatch = /^export const integrationHeaders: Readonly<Record<string, string>> = ([\s\S]*);\n$/.exec(configuration.content);
  assert.ok(configMatch, "Catalog Worker did not emit the Zendesk integration headers module");
  const injectedHeaders = JSON.parse(configMatch[1]);
  assert.deepEqual(injectedHeaders, {
    "X-Zendesk-Marketplace-Name": marketplace.name,
    "X-Zendesk-Marketplace-Organization-Id": marketplace.organizationId,
    "X-Zendesk-Marketplace-App-Id": marketplace.appId,
  }, "Catalog Worker did not inject the assigned Marketplace metadata");

  const queryResponse = await fetch(`${route.href}?site=${encodeURIComponent(sites[1].origin)}`, {
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  assert.equal(queryResponse.status, 200);
  const queryBytes = Buffer.from(await queryResponse.arrayBuffer());
  assert.deepEqual(queryBytes, servedBytes, "Catalog query parameters must not select or retarget a Zendesk site");

  const index = source.files.find((file) => file.path === "index.ts");
  assert.ok(index, "Catalog Worker omitted Zendesk app source");
  const originalIndexHash = sha256(index.content);
  const before = index.content;
  const templateOrigin = sites[0].origin;
  const templateHost = sites[0].host;
  index.content = exactReplace(
    index.content,
    'const declarationOrigin = "https://example.zendesk.com";',
    `const declarationOrigin = ${JSON.stringify(templateOrigin)};`,
    "Zendesk endpoint and site template origin",
  );
  index.content = exactReplace(
    index.content,
    'hosts: ["example.zendesk.com"],',
    `hosts: ${JSON.stringify([templateHost])},`,
    "Zendesk provider host allowlist",
  );
  index.content = exactReplace(
    index.content,
    'subdomainOf: "zendesk.com"',
    'subdomainOf: "localhost"',
    "Zendesk site suffix",
  );
  assert.notEqual(index.content, before);
  assert.ok(index.content.includes(`const declarationOrigin = ${JSON.stringify(templateOrigin)};`));
  assert.ok(index.content.includes('subdomainOf: "localhost"'));

  const fileHashes = Object.fromEntries(source.files.map((file) => [file.path, sha256(file.content)]));
  const provenance = {
    package: source.package,
    workerEntry: "src/catalog/worker.ts",
    workerEntrySha256: sha256(workerBytes),
    snapshotPath: "src/catalog/zendesk/source.json",
    snapshotSha256: sha256(snapshotBytes),
    snapshotProvenancePath: "src/catalog/zendesk/provenance.json",
    snapshotProvenanceSha256: sha256(provenanceBytes),
    snapshotFileSha256: snapshotProvenance.catalogFileSha256,
    candidateSha: candidateSha ?? null,
    upstreamPin: upstreamPin ?? null,
    carriedPatches,
    catalogRoute: "/catalog/apps/zendesk.json",
    catalogResponseSha256: sha256(servedBytes),
    catalogResponseBytes: servedBytes.byteLength,
    catalogFiles: Object.fromEntries(source.files.map((file) => [file.path, sha256(file.content)])),
    operatorMetadataHeaderNames: Object.keys(injectedHeaders).sort(),
    operatorMetadataInjectionVerified: true,
    testOverrides: {
      endpointOrigin: { from: "https://example.zendesk.com", to: templateOrigin },
      providerHosts: { from: ["example.zendesk.com"], to: [templateHost] },
      siteSubdomainOf: { from: "zendesk.com", to: "localhost" },
      sites: sites.map(({ id, origin, host }) => ({ id, origin, host })),
      urlPolicy: {
        exactAllowedOriginsEnvironment: "EXECUTOR_URL_ALLOW_HTTP_ORIGINS",
        exactAllowedOrigins: sites.map(({ origin }) => origin).sort(),
        allowLoopbackHttpEnvironment: "EXECUTOR_URL_ALLOW_LOOPBACK_HTTP",
        allowLoopbackHttp: true,
      },
    },
    deployedFiles: fileHashes,
  };
  await Promise.all([
    writeFile(join(directory, "zendesk-catalog-response.json"), servedBytes, { mode: 0o600 }),
    writeFile(join(directory, "zendesk-deployed-source.json"), `${JSON.stringify(source)}\n`, { mode: 0o600 }),
    writeFile(join(directory, "zendesk-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 }),
  ]);
  return { source, injectedHeaders, provenance };
}
