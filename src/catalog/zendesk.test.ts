import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import worker, { handleCatalog } from "./worker.ts";
import { zendeskMarketplaceMetadata } from "./zendesk/metadata.ts";

test("Zendesk publisher metadata comes from operator configuration and cannot select a site", async () => {
  const metadata = zendeskMarketplaceMetadata("publisher_123", "app_456");
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/zendesk.json?organizationId=attacker&site=other"),
    async () => { throw new Error("The carried source is local"); },
    metadata,
  );
  assert.equal(response.status, 200);
  const source = await response.json() as { files: { path: string; content: string }[] };
  const configuration = source.files.find(file => file.path === "configuration.ts")!.content;
  assert.match(configuration, /X-Zendesk-Marketplace-Organization-Id/);
  assert.match(configuration, /publisher_123/);
  assert.match(configuration, /app_456/);
  assert.ok(configuration.includes(brand.name));
  assert.doesNotMatch(configuration, /attacker|other|subdomain|client_secret/i);
  const index = source.files.find(file => file.path === "index.ts")!.content;
  assert.match(index, /Object\.entries\(integrationHeaders\)/);
  assert.match(index, /site: \{ label: "Zendesk site"/);
  assert.match(index, /account\.site/);
  assert.doesNotMatch(index, /EXECUTOR_ZENDESK_SUBDOMAIN/);
});

test("Zendesk accepts absent metadata but rejects partial IDs and header injection", () => {
  assert.equal(zendeskMarketplaceMetadata(), undefined);
  for (const [organizationId, appId] of [
    ["publisher", undefined], [undefined, "app"], ["publisher\r\nx-unsafe: yes", "app"],
    ["publisher", "app\n"], ["publisher", " app"],
  ]) {
    assert.throws(() => zendeskMarketplaceMetadata(organizationId, appId), /both assigned/);
    assert.throws(() => worker.fetch(new Request("https://catalog.example.test/catalog/apps/zendesk.json"), {
      ZENDESK_MARKETPLACE_ORGANIZATION_ID: organizationId,
      ZENDESK_MARKETPLACE_APP_ID: appId,
    }), /both assigned/);
  }
});
