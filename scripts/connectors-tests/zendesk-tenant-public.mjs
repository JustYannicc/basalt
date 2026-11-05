import assert from "node:assert/strict";

/** Drive the saved app connection through the public hosted HTTP API. */
export function proveTenantPublic({
  Effect,
  request,
  checked,
  actors,
  prefix,
  app,
  callback,
  fixtures,
  global,
}) {
  return Effect.gen(function* () {
    const accounts = [];
    const connection = (actor, site) =>
      Effect.gen(function* () {
        const result = checked(
          yield* request(actor, "POST", `${app.path}/accounts/user/zendesk/connections`, {
            destination: { kind: "personal" },
            site: site.origin,
          }),
          200,
          "Create a personal tenant connection",
        );
        return `${prefix}/connections/${result.id}`;
      });
    const site = fixtures.site("site-a");
    for (const [index, actor] of [actors.owner, actors.member].entries()) {
      const path = yield* connection(actor, site);
      const setup = checked(
        yield* request(actor, "GET", `${path}/oauth/oauth/setup`),
        200,
        "Inspect tenant sign-in",
      );
      assert.equal(setup.mode, "automatic");
      assert.equal(
        setup.firstParty.label,
        global ? "Synthetic global Zendesk" : "Zendesk tenant public client",
      );
      assert.deepEqual(
        setup.clients,
        [],
        "No stored client or manual setup may supply this connection",
      );
      assert.deepEqual(setup.scopes, ["read", "write"]);
      const started = checked(
        yield* request(actor, "POST", `${path}/oauth/start`, { method: "oauth" }),
        200,
        "Start sign-in without caller-supplied client credentials",
      );
      const url = new URL(started.authorizationUrl);
      assert.equal(url.origin, site.origin);
      assert.equal(url.pathname, "/oauth/authorizations/new");
      assert.equal(
        url.searchParams.get("client_id"),
        global ? "zendesk-fixture-client" : "site-a_zendesk",
      );
      assert.equal(url.searchParams.get("redirect_uri"), callback);
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok(url.searchParams.get("code_challenge"));
      assert.deepEqual(url.searchParams.get("scope").split(" "), ["read", "write"]);
      assert.equal(url.searchParams.has("client_secret"), false);
      assert.equal(url.searchParams.has("code_verifier"), false);
      // The fixture selects a synthetic signed-in user. Production consent remains the person's action.
      url.searchParams.set("prompt", "consent");
      if (index === 1) url.searchParams.set("fixture_user", "second");
      const returned = yield* Effect.promise(async () => {
        const response = await fetch(url, { redirect: "manual" });
        assert.equal(response.status, 302);
        return new URL(response.headers.get("location"));
      });
      assert.equal(returned.searchParams.get("state"), url.searchParams.get("state"));
      const malformed = new URL(returned);
      malformed.searchParams.set("state", "x".repeat(64));
      const before = fixtures
        .observations()
        .filter((event) => event.phase === "token_exchange").length;
      assert.equal(
        (yield* request(actor, "POST", `${path}/oauth/complete`, { callbackUrl: malformed.href }))
          .status,
        400,
      );
      assert.equal(
        fixtures.observations().filter((event) => event.phase === "token_exchange").length,
        before,
      );
      const account = checked(
        yield* request(actor, "POST", `${path}/oauth/complete`, { callbackUrl: returned.href }),
        200,
        "Complete the one-time PKCE connection",
      );
      assert.equal(account.site, site.origin);
      const health = checked(
        yield* request(actor, "POST", `${prefix}/accounts/${account.id}/health`),
        200,
        "Read the connected person's Zendesk identity",
      );
      assert.equal(health.info.externalId, index === 1 ? "9102" : "9101");
      assert.ok(health.apps.every((value) => value.check?.status === "healthy"));
      accounts.push({ actor, account });
    }
    assert.notEqual(accounts[0].account.id, accounts[1].account.id);
    const exchanges = fixtures.observations().filter((event) => event.phase === "token_exchange");
    assert.equal(exchanges.length, 2);
    for (const event of exchanges) {
      assert.equal(event.pkceVerifierMatched, true);
      assert.equal(event.clientSecretInJson, global);
      assert.equal(event.authMethod, global ? "client_secret_post" : "none");
    }
    const renewals = fixtures.observations().filter((event) => event.phase === "token_refresh");
    assert.equal(renewals.length, 2, "Expired tokens must renew through the original client");
    assert.ok(
      renewals.every(
        (event) =>
          event.authMethod === (global ? "client_secret_post" : "none") &&
          event.clientSecretInJson === global &&
          event.refreshTokenSiteMatches,
      ),
    );
    const probes = fixtures.observations().filter((event) => event.phase === "authorization_check");
    assert.equal(probes.length, global ? 0 : 2, "Only the tenant fallback checks registration");
    assert.ok(probes.every((event) => !event.cookiePresent && !event.authHeaderPresent));
    if (!global) {
      fixtures.revokeTenantUser(9101);
      const revoked = checked(
        yield* request(
          accounts[0].actor,
          "POST",
          `${prefix}/accounts/${accounts[0].account.id}/health`,
        ),
        200,
        "Read health after synthetic user revocation",
      );
      assert.ok(revoked.apps.some((value) => value.check?.status === "credentials_rejected"));
      const other = checked(
        yield* request(
          accounts[1].actor,
          "POST",
          `${prefix}/accounts/${accounts[1].account.id}/health`,
        ),
        200,
        "The other person's grant remains usable",
      );
      assert.equal(other.info.externalId, "9102");
      assert.ok(other.apps.every((value) => value.check?.status === "healthy"));
      const path = yield* connection(actors.owner, fixtures.site("site-b"));
      fixtures.setTenantCallback("site-b", "https://another-client.example.test/callback");
      const wrongCallback = yield* request(actors.owner, "POST", `${path}/oauth/start`, {
        method: "oauth",
      });
      assert.equal(wrongCallback.status, 422);
      assert.equal(wrongCallback.body.reason, "invalid_client");
      assert.ok(wrongCallback.body.clientSetupInstructions.includes(callback));
      fixtures.setTenantCallback("site-b", callback);
      for (const [status, reason] of [
        [503, "service_unavailable"],
        [429, "rate_limited"],
      ]) {
        fixtures.setAuthorizationStatus("site-b", status);
        const unavailable = yield* request(actors.owner, "POST", `${path}/oauth/start`, {
          method: "oauth",
        });
        assert.equal(unavailable.status, 422);
        assert.equal(unavailable.body.reason, reason);
        assert.equal(unavailable.body.clientSetupInstructions, undefined);
        if (status === 429) assert.ok(unavailable.body.retryAfter);
      }
      fixtures.setAuthorizationStatus("site-b", undefined);
      const interrupted = checked(
        yield* request(actors.owner, "POST", `${path}/oauth/start`, { method: "oauth" }),
        200,
        "Start before a synthetic admin removes the client",
      );
      const pending = new URL(interrupted.authorizationUrl);
      pending.searchParams.set("prompt", "consent");
      const interruptedCallback = yield* Effect.promise(async () => {
        const response = await fetch(pending, { redirect: "manual" });
        assert.equal(response.status, 302);
        return response.headers.get("location");
      });
      fixtures.removeTenantClient("site-b");
      const removed = yield* request(actors.owner, "POST", `${path}/oauth/complete`, {
        callbackUrl: interruptedCallback,
      });
      assert.equal(removed.status, 400);
      assert.equal(removed.body.reason, "invalid_client");
      assert.match(removed.body.clientSetupInstructions, /public client site-b_zendesk/);
      assert.ok(removed.body.clientSetupInstructions.includes(callback));
      const missing = yield* request(actors.owner, "POST", `${path}/oauth/start`, {
        method: "oauth",
      });
      assert.equal(missing.status, 422);
      assert.equal(missing.body._tag, "OAuthSetupFailed");
      assert.equal(missing.body.reason, "invalid_client");
      assert.match(
        missing.body.clientSetupInstructions,
        /Admin Center > Apps and integrations > APIs > OAuth clients/,
      );
      assert.match(missing.body.clientSetupInstructions, /public client site-b_zendesk/);
      assert.ok(missing.body.clientSetupInstructions.includes(callback));
      assert.match(missing.body.clientSetupInstructions, /No client secret is needed/);
      assert.equal(
        fixtures.observations().filter((event) => event.phase === "token_exchange").length,
        2,
        "A missing client must not exchange a token or save an account",
      );
      const saved = checked(
        yield* request(actors.owner, "GET", `${path}`),
        200,
        "Read the refused connection",
      );
      assert.notEqual(saved.state.status, "completed");
    }
    return {
      global,
      pkceExchanges: exchanges.length,
      anonymousChecks: probes.length,
      perUserGrants: true,
      missingClientRefused: !global,
      syntheticUserRevocation: !global,
    };
  });
}
