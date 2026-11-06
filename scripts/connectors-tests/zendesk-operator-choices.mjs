import assert from "node:assert/strict";

const loopback = "http://localhost:27439/callback";

/** Exercise the same connection endpoints used by the existing callback-paste screen. */
export function proveOperatorChoices({
  Effect,
  request,
  checked,
  actors,
  prefix,
  app,
  callback,
  fixtures,
  global,
  advanceClock,
}) {
  return Effect.gen(function* () {
    const actor = actors.owner;
    const site = fixtures.site("site-a");
    const exchangeCount = () =>
      fixtures.observations().filter((entry) => entry.phase === "token_exchange").length;
    const create = () =>
      Effect.gen(function* () {
        const result = checked(
          yield* request(actor, "POST", `${app.path}/accounts/user/zendesk/connections`, {
            destination: { kind: "personal" },
            site: site.origin,
          }),
          200,
          "Create a callback-paste connection",
        );
        return `${prefix}/connections/${result.id}`;
      });
    const start = (path, operator) =>
      request(actor, "POST", `${path}/oauth/start`, {
        method: "oauth",
        ...(operator === undefined ? {} : { client: { automatic: true, operator } }),
      });
    const complete = (path, callbackUrl) =>
      request(actor, "POST", `${path}/oauth/complete`, { callbackUrl });
    const consent = (started) =>
      Effect.promise(async () => {
        const url = new URL(started.authorizationUrl);
        assert.equal(url.searchParams.get("redirect_uri"), loopback);
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.ok(url.searchParams.get("code_challenge"));
        assert.equal(url.searchParams.has("code_verifier"), false);
        assert.equal(url.searchParams.has("client_secret"), false);
        url.searchParams.set("prompt", "consent");
        const response = await fetch(url, { redirect: "manual" });
        assert.equal(response.status, 302);
        return new URL(response.headers.get("location"));
      });

    fixtures.setTenantCallback(site.id, loopback);
    const path = yield* create();
    const setup = checked(
      yield* request(actor, "GET", `${path}/oauth/oauth/setup`),
      200,
      "Inspect the three sign-in choices",
    );
    const ids = setup.operatorClients.map((choice) => choice.id);
    assert.deepEqual(
      ids,
      global
        ? ["zendesk-proof", "zendesk-tenant-proof", "zendesk-tenant-paste-proof"]
        : ["zendesk-tenant-proof", "zendesk-tenant-paste-proof"],
    );
    const hosted = setup.operatorClients.find((choice) => choice.id === "zendesk-tenant-proof");
    const paste = setup.operatorClients.find(
      (choice) => choice.id === "zendesk-tenant-paste-proof",
    );
    assert.equal(hosted.available, false);
    assert.equal(hosted.redirectUri, callback);
    assert.equal(
      hosted.setupInstructions,
      "A Zendesk admin adds this callback URL to the public OAuth client site-a_zendesk with read and write access.",
    );
    assert.equal(paste.available, true);
    assert.equal(paste.redirectUri, loopback);
    assert.equal(setup.firstParty.label, global ? "Synthetic global Zendesk" : paste.label);
    const automatic = checked(
      yield* start(path),
      200,
      "Automatically choose the first working callback",
    );
    const chosen = new URL(automatic.authorizationUrl);
    assert.equal(
      chosen.searchParams.get("client_id"),
      global ? "zendesk-fixture-client" : "site-a_zendesk",
    );
    assert.equal(automatic.redirectUri, global ? callback : loopback);

    const before = exchangeCount();
    const refused = yield* start(path, hosted.id);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.reason, "invalid_client");
    assert.equal(refused.body.clientSetupInstructions, hosted.setupInstructions);
    const unknown = yield* start(path, "unreviewed-client");
    assert.equal(unknown.status, 422);
    assert.equal(exchangeCount(), before);

    const started = checked(
      yield* start(path, paste.id),
      200,
      "Explicitly select the company client's existing localhost callback",
    );
    assert.equal(started.redirectUri, loopback);
    const returned = yield* consent(started);
    const corrupt = (change) => {
      const value = new URL(returned);
      change(value);
      return value.href;
    };
    const invalid = [
      ["not a callback URL", null],
      [corrupt((url) => url.searchParams.set("state", "x".repeat(64))), "sign_in_not_found"],
      [
        corrupt((url) => url.searchParams.append("state", url.searchParams.get("state"))),
        "callback_malformed",
      ],
      [
        corrupt((url) => {
          url.hostname = "127.0.0.1";
        }),
        "redirect_mismatch",
      ],
      [
        corrupt((url) => {
          url.hostname = "attacker.example.test";
        }),
        "redirect_mismatch",
      ],
      [
        corrupt((url) => {
          url.port = "27440";
        }),
        "redirect_mismatch",
      ],
      [
        corrupt((url) => {
          url.protocol = "https:";
        }),
        "redirect_mismatch",
      ],
      [
        corrupt((url) => {
          url.pathname = "/another-callback";
        }),
        "redirect_mismatch",
      ],
      [
        corrupt((url) => {
          url.username = "unexpected";
        }),
        "callback_malformed",
      ],
      [
        corrupt((url) => {
          url.hash = "unexpected";
        }),
        "callback_malformed",
      ],
    ];
    for (const [value, reason] of invalid) {
      const response = yield* complete(path, value);
      assert.equal(response.status, 400, `Refuse ${reason} before exchanging a code`);
      assert.equal(reason === null ? response.body : response.body.reason, reason);
      assert.equal(exchangeCount(), before);
    }
    const account = checked(
      yield* complete(path, returned.href),
      200,
      "Complete the pasted localhost address",
    );
    assert.equal(account.site, site.origin);
    assert.equal(exchangeCount(), before + 1);
    const exchange = fixtures
      .observations()
      .filter((entry) => entry.phase === "token_exchange")
      .at(-1);
    assert.equal(exchange.authMethod, "none");
    assert.equal(exchange.pkceVerifierMatched, true);
    assert.equal(exchange.clientSecretInJson, false);
    const repeat = checked(
      yield* complete(path, returned.href),
      200,
      "Read an already completed connection idempotently",
    );
    assert.equal(repeat.id, account.id);
    assert.equal(
      exchangeCount(),
      before + 1,
      "Repeating completion never exchanges the code again",
    );
    const other = yield* create();
    const replay = yield* complete(other, returned.href);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.reason, "sign_in_used");
    assert.equal(exchangeCount(), before + 1);
    const second = checked(yield* start(other, paste.id), 200, "Start a new one-time sign-in");
    const secondReturn = yield* consent(second);
    secondReturn.searchParams.set("code", returned.searchParams.get("code"));
    const reusedCode = yield* complete(other, secondReturn.href);
    assert.equal(reusedCode.status, 400);
    assert.equal(reusedCode.body.reason, "authorization_code_rejected");
    assert.equal(reusedCode.body.cause.providerError, "invalid_grant");
    assert.equal(
      exchangeCount(),
      before + 1,
      "A consumed code cannot create another account under fresh state",
    );

    if (global) {
      fixtures.setAuthorizationStatus(site.id, 503);
      const available = checked(
        yield* request(actor, "GET", `${other}/oauth/oauth/setup`),
        200,
        "A public-client outage must not hide a configured Marketplace client",
      );
      assert.equal(available.firstParty.label, "Synthetic global Zendesk");
      fixtures.setAuthorizationStatus(site.id, undefined);
    } else {
      fixtures.setTenantCallback(site.id, "https://unregistered.example.test/callback");
      const none = checked(
        yield* request(actor, "GET", `${other}/oauth/oauth/setup`),
        200,
        "Explain why neither company callback works",
      );
      assert.equal(none.mode, "client-required");
      assert.equal(none.operatorClients.length, 2);
      assert.ok(none.operatorClients.every((choice) => !choice.available));
      const unavailable = yield* start(other);
      assert.equal(unavailable.status, 422);
      assert.equal(unavailable.body.reason, "invalid_client");
      assert.equal(exchangeCount(), before + 1);
      fixtures.setTenantCallback(site.id, loopback);
    }

    const expiring = yield* create();
    const expiringStart = checked(
      yield* start(expiring, paste.id),
      200,
      "Start the expiring paste flow",
    );
    const expiringReturn = yield* consent(expiringStart);
    yield* advanceClock(Math.max(1, Date.parse(expiringStart.expiresAt) - Date.now() + 1_000));
    const expired = yield* complete(expiring, expiringReturn.href);
    assert.equal(expired.status, 400);
    assert.equal(expired.body.reason, "sign_in_expired");
    assert.equal(
      exchangeCount(),
      before + 1,
      "An expired attempt never reaches the token endpoint",
    );
    return {
      order: ids,
      automaticRedirect: automatic.redirectUri,
      invalidPastes: invalid.length,
      loopbackPkce: true,
      stateAndRedirectChecked: true,
      codeConsumedOnce: true,
      expiredFlowRefused: true,
    };
  });
}
