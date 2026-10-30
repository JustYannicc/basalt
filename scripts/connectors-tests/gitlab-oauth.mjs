import assert from "node:assert/strict";
import { URL } from "node:url";
import { gitlabHostedClient } from "./gitlab-fixture.mjs";

const connectPath = (appPath) => appPath + "/accounts/user/gitlab/connections";
const setupPath = (prefix, connectionId) =>
  prefix + "/connections/" + connectionId + "/oauth/oauth/setup";
const startPath = (prefix, connectionId) =>
  prefix + "/connections/" + connectionId + "/oauth/start";
const completePath = (prefix, connectionId) =>
  prefix + "/connections/" + connectionId + "/oauth/complete";

/** Prove each instance owns OAuth setup, callback, refresh, health and reconnect. */
export function proveGitLabOAuth({
  Effect,
  request,
  checked,
  actors,
  prefix,
  app,
  callback,
  fixtures,
  siteA,
  siteB,
  prove,
}) {
  const observations = fixtures.observations;
  const hostedSecret = gitlabHostedClient.secret;
  const accountPath = (id) => prefix + "/accounts/" + id;
  return Effect.gen(function* () {
    const connectionFor = (actor, site, account) => Effect.gen(function* () {
      const body = {
        destination: { kind: "personal" },
        site: site.origin,
        ...(account === undefined ? {} : { account }),
      };
      return yield* request(actor, "POST", connectPath(app.path), body);
    });

    const oauthFlow = (actor, site, account) => Effect.gen(function* () {
      const connection = checked(
        yield* connectionFor(actor, site, account),
        200,
        "Create GitLab OAuth connection at " + site.id,
      );
      const peer = site.id === "instance-a" ? siteB : siteA;
      const setupResponse = yield* request(
        actor,
        "GET",
        setupPath(prefix, connection.id) + "?site=" + encodeURIComponent(peer.origin),
      );
      assert.equal(setupResponse.status, 200, "GitLab OAuth setup endpoint must respond");
      const setup = setupResponse.body;
      assert.equal(setup.issuer, site.origin + "/oauth/token",
        "A caller-supplied site cannot retarget saved OAuth setup");
      assert.notEqual(setup.mode, "automatic",
        "Self-managed GitLab must use its own OAuth client");
      assert.equal(setup.firstParty ?? null, null,
        "The GitLab.com first-party client must not be offered to a self-managed instance");
      assert.equal(JSON.stringify(setup).includes(gitlabHostedClient.id), false);
      assert.equal(JSON.stringify(setup).includes(hostedSecret), false);

      const client = {
        clientId: site.client.clientId,
        clientSecret: site.client.clientSecret,
      };
      const started = checked(yield* request(
        actor,
        "POST",
        startPath(prefix, connection.id),
        { method: "oauth", label: "Synthetic " + site.id, client },
      ), 200, "Start instance-owned GitLab OAuth at " + site.id);
      const authorization = new URL(started.authorizationUrl);
      assert.equal(started.redirectUri, callback);
      assert.equal(authorization.origin, site.origin);
      assert.equal(authorization.pathname, "/oauth/authorize");
      assert.equal(authorization.searchParams.get("client_id"), client.clientId);
      assert.equal(authorization.searchParams.has("client_secret"), false);
      assert.equal(authorization.searchParams.get("redirect_uri"), callback);
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorization.searchParams.get("response_type"), "code");
      assert.equal(JSON.stringify(started).includes(hostedSecret), false);

      const authorizationResponse = yield* Effect.promise(() =>
        fetch(authorization.href, { redirect: "manual" }),
      );
      assert.equal(authorizationResponse.status, 302);
      const callbackUrl = authorizationResponse.headers.get("location");
      assert.ok(callbackUrl, "GitLab fixture omitted the OAuth callback");
      const returned = new URL(callbackUrl);
      assert.equal(returned.origin, new URL(callback).origin);
      assert.equal(returned.pathname, new URL(callback).pathname);
      assert.equal(returned.searchParams.get("state"), authorization.searchParams.get("state"));
      prove(true, "OAuth authorization, redirect URI and PKCE use the saved " + site.id + " origin");
      return { actor, site, connection, client, callbackUrl };
    });

    const flowA = yield* oauthFlow(actors.member, siteA);
    const flowB = yield* oauthFlow(actors.admin, siteB);
    const exchangesBeforeCrossCallback = observations.filter((event) =>
      event.phase === "token_exchange" || event.phase === "token_refresh",
    ).length;
    const crossCallback = yield* request(
      actors.member,
      "POST",
      completePath(prefix, flowA.connection.id),
      { callbackUrl: flowB.callbackUrl, site: siteB.origin },
    );
    prove(crossCallback.status >= 400 && crossCallback.status < 500,
      "An OAuth callback from the peer GitLab instance is refused");
    prove(observations.filter((event) =>
      event.phase === "token_exchange" || event.phase === "token_refresh",
    ).length === exchangesBeforeCrossCallback,
    "A cross-origin callback is refused before either instance receives a token request");

    const complete = (flow) => Effect.gen(function* () {
      const saved = checked(yield* request(
        flow.actor,
        "POST",
        completePath(prefix, flow.connection.id),
        { callbackUrl: flow.callbackUrl },
      ), 200, "Complete BYO GitLab OAuth at " + flow.site.id);
      prove(saved.id !== undefined, "OAuth account is saved for " + flow.site.id);
      return saved;
    });
    const accountA = yield* complete(flowA);
    const accountB = yield* complete(flowB);
    prove(accountA.id !== accountB.id,
      "Separate GitLab instances keep separate account IDs");

    const changedReconnect = yield* connectionFor(actors.member, siteB, accountA.id);
    prove(changedReconnect.status === 422,
      "A saved self-managed account cannot reconnect to another instance");
    const reconnectSiteRequests = observations.filter((event) =>
      event.phase === "authorization" && [siteA.id, siteB.id].includes(event.site),
    ).length;
    prove(reconnectSiteRequests === 2,
      "A refused reconnect does not start OAuth at either instance");

    const sameSiteReconnect = yield* oauthFlow(actors.member, siteA, accountA.id);
    const reconnected = yield* complete(sameSiteReconnect);
    prove(reconnected.id === accountA.id,
      "Reconnecting at the saved GitLab origin preserves the account ID");

    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    const healthA = checked(
      yield* request(actors.member, "POST", accountPath(accountA.id) + "/health"),
      200,
      "Health-check the GitLab OAuth account at instance A",
    );
    const healthB = checked(
      yield* request(actors.admin, "POST", accountPath(accountB.id) + "/health"),
      200,
      "Health-check the GitLab OAuth account at instance B",
    );
    assert.equal(healthA.info?.externalId, "4101");
    assert.equal(healthB.info?.externalId, "4202");
    const refreshed = observations.filter((event) => event.phase === "token_refresh");
    for (const site of [siteA, siteB]) {
      const refresh = refreshed.find((event) => event.site === site.id);
      assert.ok(refresh, "GitLab OAuth token must refresh at " + site.id);
      assert.equal(refresh.path, "/oauth/token");
      assert.equal(refresh.clientId, site.client.clientId);
      assert.equal(refresh.clientSecretMatches, true);
      assert.equal(refresh.sharedClientAttempt, false);
      assert.equal(refresh.refreshTokenSiteMatches, true);
      assert.equal(refresh.redirectUriMatched, true);
      const healthRequest = observations.find((event) =>
        event.site === site.id && event.phase === "health" && event.authKind === "oauth",
      );
      assert.ok(healthRequest?.credentialSiteMatches,
        "GitLab OAuth health must use only the saved " + site.id + " token");
    }
    prove(true, "GitLab token exchange, rotating refresh and health stay at each saved origin");
    return { accountA, accountB };
  });
}
