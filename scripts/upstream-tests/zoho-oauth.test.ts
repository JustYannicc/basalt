import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";

const { firstPartyOAuthClients } = await import(new URL(
  "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts", import.meta.url,
).href);

type Client = {
  id: string; label: string; clientId: string; clientSecret: Redacted.Redacted<string>;
  server: { authorizationUrl: string; tokenUrl: string; scopeSeparator: string; grantedScopeSeparator: string;
    authorizationParams: { access_type: string; prompt: string } };
  defaultScopes: string[]; placement: { hosts: string[]; scheme: string };
};
const clients = (settings: Record<string, string>) => Effect.runPromise(
  firstPartyOAuthClients({ testDefinitions: false }).pipe(Effect.provideService(
    ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(settings),
  )),
) as Promise<Client[]>;

const regions = [
  ["us", "accounts.zoho.com", "www.zohoapis.com"],
  ["eu", "accounts.zoho.eu", "www.zohoapis.eu"],
  ["in", "accounts.zoho.in", "www.zohoapis.in"],
  ["au", "accounts.zoho.com.au", "www.zohoapis.com.au"],
  ["jp", "accounts.zoho.jp", "www.zohoapis.jp"],
  ["ca", "accounts.zohocloud.ca", "www.zohoapis.ca"],
  ["sa", "accounts.zoho.sa", "www.zohoapis.sa"],
  ["cn", "accounts.zoho.com.cn", "www.zohoapis.com.cn"],
] as const;

test("the eight Zoho data centers share one optional Multi-DC pair and preserve regional placement", async () => {
  assert.deepEqual(await clients({}), []);
  const configured = await clients({ EXECUTOR_PRODUCT_NAME: "Signalbox",
    EXECUTOR_OAUTH_ZOHO_CLIENT_ID: "synthetic-zoho-client", EXECUTOR_OAUTH_ZOHO_CLIENT_SECRET: "synthetic-zoho-secret" });
  assert.equal(configured.length, 8);
  for (const [region, accounts, api] of regions) {
    const client = configured.find(client => client.id === `zoho-${region}`)!;
    assert.ok(client);
    assert.equal(client.clientId, "synthetic-zoho-client");
    assert.equal(Redacted.value(client.clientSecret), "synthetic-zoho-secret");
    assert.equal(client.label, `Signalbox for Zoho CRM (${region.toUpperCase()})`);
    assert.equal(client.server.authorizationUrl, `https://${accounts}/oauth/v2/auth`);
    assert.equal(client.server.tokenUrl, `https://${accounts}/oauth/v2/token`);
    assert.equal(client.server.scopeSeparator, ",");
    assert.equal(client.server.grantedScopeSeparator, ",");
    assert.deepEqual(client.server.authorizationParams, { access_type: "offline", prompt: "consent" });
    assert.deepEqual(client.placement, { hosts: [api], scheme: "Zoho-oauthtoken" });
    assert.equal(client.defaultScopes.length, 14);
    assert.ok(client.defaultScopes.includes("ZohoCRM.Files.CREATE"));
    assert.ok(client.defaultScopes.includes("ZohoCRM.Files.READ"));
    assert.ok(!JSON.stringify(client).includes("synthetic-zoho-secret"));
  }
});

test("a partial Zoho pair fails with setting names without repeating the secret", async () => {
  for (const part of ["ID", "SECRET"]) {
    await assert.rejects(clients({ [`EXECUTOR_OAUTH_ZOHO_CLIENT_${part}`]: "private-fixture-value" }), error => {
      assert.match(String(error), /EXECUTOR_OAUTH_ZOHO_CLIENT_(?:ID|SECRET)/);
      assert.ok(!String(error).includes("private-fixture-value"));
      return true;
    });
  }
});
