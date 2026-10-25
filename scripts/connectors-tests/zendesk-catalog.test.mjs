import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startZendeskCatalogWorker, loadZendeskCatalogSource } from "./zendesk-catalog.mjs";
import { marketplaceHeaderNames } from "./zendesk-fixture.mjs";
import { startZendeskFixtures } from "./zendesk-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upstream = process.env.CONNECTORS_UPSTREAM ?? join(root, ".upstream");
const evidenceRoot = join(root, ".generated/connectors-proof");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(evidenceRoot, "zendesk-catalog-test-"));
const marketplace = {
  name: "Signalbox",
  organizationId: "fixture-organization",
  appId: "fixture-app",
};
const metadata = {
  "X-Zendesk-Marketplace-Name": marketplace.name,
  "X-Zendesk-Marketplace-Organization-Id": marketplace.organizationId,
  "X-Zendesk-Marketplace-App-Id": marketplace.appId,
};
const fixtures = await startZendeskFixtures({ marketplaceHeaders: metadata });
after(() => fixtures.stop());
const worker = await startZendeskCatalogWorker({ root, upstream, directory, marketplace });
after(() => worker.stop());

test("Zendesk source comes from the catalog Worker and carries pinned provenance plus explicit loopback overrides", async () => {
  const { source, injectedHeaders, provenance } = await loadZendeskCatalogSource({
    root,
    catalogOrigin: worker.origin,
    directory,
    sites: fixtures.sites,
    marketplace,
  });

  assert.deepEqual(injectedHeaders, metadata);
  assert.deepEqual(Object.keys(injectedHeaders).sort(), [...marketplaceHeaderNames].sort());
  assert.equal(provenance.package, "zendesk");
  assert.equal(provenance.catalogRoute, "/catalog/apps/zendesk.json");
  assert.match(provenance.catalogResponseSha256, /^[a-f0-9]{64}$/);
  assert.equal(provenance.operatorMetadataInjectionVerified, true);
  assert.equal(provenance.testOverrides.siteSubdomainOf.from, "zendesk.com");
  assert.equal(provenance.testOverrides.siteSubdomainOf.to, "localhost");
  assert.deepEqual(provenance.testOverrides.providerHosts.to, [fixtures.sites[0].host]);
  assert.equal(provenance.testOverrides.urlPolicy.exactAllowedOriginsEnvironment, "EXECUTOR_URL_ALLOW_HTTP_ORIGINS");
  assert.equal(provenance.testOverrides.urlPolicy.allowLoopbackHttpEnvironment, "EXECUTOR_URL_ALLOW_LOOPBACK_HTTP");
  assert.deepEqual(provenance.testOverrides.urlPolicy.exactAllowedOrigins, fixtures.sites.map(({ origin }) => origin).sort());
  assert.equal(provenance.testOverrides.urlPolicy.allowLoopbackHttp, true);

  const index = source.files.find((file) => file.path === "index.ts");
  assert.ok(index);
  assert.ok(index.content.includes(`const declarationOrigin = ${JSON.stringify(fixtures.sites[0].origin)};`));
  assert.ok(index.content.includes(`hosts: ${JSON.stringify([fixtures.sites[0].host])}`));
  assert.equal(index.content.includes(JSON.stringify(fixtures.sites[1].host)), false);
  assert.ok(index.content.includes('subdomainOf: "localhost"'));
});
