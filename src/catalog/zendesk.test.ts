import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import worker, { handleCatalog } from "./worker.ts";
import sourceSnapshot from "./zendesk/source.json" with { type: "json" };
import sourceProvenance from "./zendesk/provenance.json" with { type: "json" };
import { zendeskIcons } from "./zendesk/logo.ts";
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
  assert.match(index, /liveOpenapiRouter/);
  assert.match(index, /tool\.kind === "mutation" \? always\(\) : undefined/);
  assert.match(index, /marketplaceFetch\(accountOrigin\(account\), fetch\)/);
  assert.match(index, /fetch: marketplaceFetch/);
  assert.doesNotMatch(index, /EXECUTOR_ZENDESK_SUBDOMAIN/);
});

test("Zendesk source carries the full Support API router and official primary logo", async () => {
  const sourceResponse = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/zendesk.json"),
    async () => { throw new Error("The carried source is local"); },
  );
  const served = await sourceResponse.json() as {
    files: { path: string; content: string }[];
  };
  assert.deepEqual(served, sourceSnapshot);

  const readme = served.files.find(file => file.path === "README.md")!.content;
  const index = served.files.find(file => file.path === "index.ts")!.content;
  const openapi = served.files.find(file => file.path === "openapi.ts")!.content;
  const iconModule = served.files.find(file => file.path === "icon.ts")!.content;
  assert.match(readme, /official Support API v2/);
  assert.match(readme, /`read`, `write` and `impersonate`/);
  assert.match(openapi, /allowedOrigin: site/);
  assert.match(openapi, /baseUrl: site/);
  assert.match(openapi, /oauth: \[\{ scheme: "basicAuth"/);
  assert.match(index, /const scopes = \["read", "write", "impersonate"\]/);
  assert.match(index, /withApprovals\(/);
  assert.match(index, /tool\.kind === "mutation" \? always\(\) : undefined/);
  assert.match(iconModule, /data:image\/png;base64,/);
  assert.deepEqual(zendeskIcons, [{
    src: (JSON.parse(iconModule.match(/= ([\s\S]*);\n$/)?.[1] ?? "null") as { src: string }[])[0]!.src,
    mimeType: "image/png",
    theme: "light",
  }]);

  const iconBytes = Buffer.from(zendeskIcons[0]!.src.replace("data:image/png;base64,", ""), "base64");
  assert.equal(iconBytes.byteLength, sourceProvenance.vendorLogo.bytes);
  assert.equal(createHash("sha256").update(iconBytes).digest("hex"), sourceProvenance.vendorLogo.sha256);
  assert.equal(sourceProvenance.vendorLogo.url,
    "https://web-assets.zendesk.com/zendesk/pages/company/brand-guidelines/primarylogo.png");
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
