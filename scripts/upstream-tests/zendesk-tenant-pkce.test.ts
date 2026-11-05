import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { firstPartyOAuthClients } from "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts";
import { firstPartyClientAtSite } from "../../.upstream/packages/sdk/src/implementation/oauth-site.ts";
import { defaultUrlPolicy } from "../../.upstream/packages/utils/src/url-policy.ts";

const clients = (settings: Record<string, string> = {}) =>
  Effect.runPromise(
    firstPartyOAuthClients({ testDefinitions: false }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(settings)),
    ),
  );

test("Zendesk uses a public tenant client without hosted credentials or publisher metadata", async () => {
  const configured = await clients();
  assert.deepEqual(
    configured.map((client) => client.id),
    ["zendesk-tenant"],
  );
  const tenant = configured[0]!;
  assert.equal(tenant.tokenEndpointAuthMethod, "none");
  assert.equal(tenant.clientSecret, undefined);
  assert.deepEqual(tenant.defaultScopes, ["read", "write"]);
  assert.deepEqual(tenant.allowedScopes, ["read", "write"]);
  assert.equal(tenant.checkAuthorization, true);
  for (const site of ["alpha", "beta"]) {
    const selected = firstPartyClientAtSite(
      tenant,
      `https://${site}.zendesk.com`,
      defaultUrlPolicy,
    )!;
    assert.equal(selected.clientId, `${site}_zendesk`);
    assert.equal(
      selected.server.authorizationUrl,
      `https://${site}.zendesk.com/oauth/authorizations/new`,
    );
    assert.equal(selected.server.tokenUrl, `https://${site}.zendesk.com/oauth/tokens`);
    assert.deepEqual(selected.placement.hosts, [`${site}.zendesk.com`]);
  }
  for (const site of [
    undefined,
    "https://zendesk.com",
    "https://x.y.zendesk.com",
    "http://alpha.zendesk.com",
    "https://alpha.zendesk.com.evil.test",
    "https://alpha.zendesk.com/path",
  ]) {
    assert.equal(
      firstPartyClientAtSite(tenant, site, defaultUrlPolicy),
      undefined,
      site ?? "no site",
    );
  }
});

test("the configured global Zendesk client comes first and partial configuration fails closed", async () => {
  const configured = await clients({
    EXECUTOR_OAUTH_ZENDESK_CLIENT_ID: "synthetic-global-client",
    EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET: "synthetic-global-secret",
  });
  assert.deepEqual(
    configured.map((client) => client.id),
    ["zendesk", "zendesk-tenant"],
  );
  const global = firstPartyClientAtSite(
    configured[0]!,
    "https://alpha.zendesk.com",
    defaultUrlPolicy,
  )!;
  assert.equal(global.clientId, "synthetic-global-client");
  assert.equal(global.tokenEndpointAuthMethod, "client_secret_post");
  assert.equal(global.checkAuthorization, undefined);
  for (const part of ["ID", "SECRET"]) {
    await assert.rejects(
      clients({ [`EXECUTOR_OAUTH_ZENDESK_CLIENT_${part}`]: "private-fixture-value" }),
      (error) => {
        assert.match(String(error), /EXECUTOR_OAUTH_ZENDESK_CLIENT_/);
        assert.ok(!String(error).includes("private-fixture-value"));
        return true;
      },
    );
  }
});
