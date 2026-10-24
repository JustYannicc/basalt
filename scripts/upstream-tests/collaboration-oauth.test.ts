import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";

const { firstPartyOAuthClients } = await import(new URL(
  "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts", import.meta.url,
).href);

const clients = (settings: Record<string, string>) => Effect.runPromise(
  firstPartyOAuthClients({ testDefinitions: false }).pipe(Effect.provideService(
    ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(settings),
  )),
) as Promise<{ id: string; label: string; clientId: string; clientSecret: Redacted.Redacted<string>;
  server: { authorizationUrl: string; tokenUrl: string }; defaultScopes: string[];
  placement: { hosts: string[] } }[]>;

const settings = {
  EXECUTOR_PRODUCT_NAME: "Signalbox",
  EXECUTOR_OAUTH_GITLAB_CLIENT_ID: "synthetic-gitlab-client",
  EXECUTOR_OAUTH_GITLAB_CLIENT_SECRET: "synthetic-gitlab-secret",
  EXECUTOR_OAUTH_MIRO_CLIENT_ID: "synthetic-miro-client",
  EXECUTOR_OAUTH_MIRO_CLIENT_SECRET: "synthetic-miro-secret",
};

test("hosted collaboration clients are optional and use separate credentials", async () => {
  assert.deepEqual(await clients({}), []);
  const configured = await clients(settings);
  assert.deepEqual(configured.map(client => client.id), ["gitlab", "miro"]);
  for (const client of configured) {
    assert.equal(client.label, `Signalbox for ${client.id === "gitlab" ? "GitLab" : "Miro"}`);
    assert.equal(client.clientId, `synthetic-${client.id}-client`);
    assert.equal(Redacted.value(client.clientSecret), `synthetic-${client.id}-secret`);
    assert.ok(!JSON.stringify(client).includes(`synthetic-${client.id}-secret`));
  }
});

test("collaboration clients match catalog authorization servers and restrict token destinations", async () => {
  const configured = await clients(settings);
  const gitlab = configured.find(client => client.id === "gitlab")!;
  assert.equal(gitlab.server.authorizationUrl, "https://gitlab.com/oauth/authorize");
  assert.equal(gitlab.server.tokenUrl, "https://gitlab.com/oauth/token");
  assert.deepEqual(gitlab.defaultScopes, ["api", "read_user"]);
  assert.deepEqual(gitlab.placement.hosts, ["gitlab.com"]);
  const miro = configured.find(client => client.id === "miro")!;
  assert.equal(miro.server.authorizationUrl, "https://miro.com/oauth/authorize");
  assert.equal(miro.server.tokenUrl, "https://api.miro.com/v1/oauth/token");
  assert.deepEqual(miro.defaultScopes, ["boards:read", "boards:write", "organizations:read", "organizations:teams:read", "organizations:teams:write"]);
  assert.deepEqual(miro.placement.hosts, ["api.miro.com"]);
});

test("native loader refuses a partial collaboration client without exposing its secret", async () => {
  for (const provider of ["GITLAB", "MIRO"]) {
    const secret = `EXECUTOR_OAUTH_${provider}_CLIENT_SECRET`;
    await assert.rejects(clients({ [secret]: "private-fixture-value" }), error => {
      assert.match(String(error), new RegExp(secret));
      assert.ok(!String(error).includes("private-fixture-value"));
      return true;
    });
  }
});
