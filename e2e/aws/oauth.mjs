import { Effect } from "effect";
import { connectionsPath, requirementPath } from "../../.upstream/e2e/support/app-accounts.ts";

/** Run AWS DCR, full pasted-callback validation, account isolation and replay checks. */
export function proveAwsOAuth({ request, checked, check, equal, actors, prefix, fixture, app }) {
  return Effect.gen(function* () {
    const connection = (actor) => Effect.gen(function* () {
      const response = yield* request(
        actor,
        "POST",
        connectionsPath(`${prefix}/apps/${app.id}`, "user", "aws"),
        { destination: { kind: "personal" } },
      );
      return checked(response, 200, "Create a personal AWS connection");
    });
    const start = (actor, accountConnection) => Effect.gen(function* () {
      const response = yield* request(
        actor,
        "POST",
        `${prefix}/connections/${accountConnection.id}/oauth/start`,
        { method: "oauth" },
      );
      return { response, body: response.status === 200 ? response.body : undefined };
    });
    const complete = (actor, accountConnection, callbackUrl) =>
      request(actor, "POST", `${prefix}/connections/${accountConnection.id}/oauth/complete`, {
        callbackUrl,
      });
    const refused = (actor, target, callbackUrl, label) => Effect.gen(function* () {
      const response = yield* complete(actor, target, callbackUrl);
      check(response.status >= 400, `${label}: host accepted a callback it should reject`);
    });

    const ownerConnection = yield* connection(actors.owner);
    fixture.setCallbacksAllowed(false);
    const rejected = yield* start(actors.owner, ownerConnection);
    check(rejected.response.status >= 400, "Hosted callback refusal should stop DCR");
    const rejectedRegistration = fixture.observations().registrations.at(-1);
    check(rejectedRegistration, "The host did not attempt OAuth client registration");
    equal(rejectedRegistration.scopeCount, 0, "AWS DCR must not request scope strings");
    equal(rejectedRegistration.clientType, "none", "AWS DCR must use a public client");
    equal(rejectedRegistration.callbacks, [fixture.expectedCallback],
      "AWS must refuse the provider-owned loopback callback before authorization starts");
    check(
      !JSON.stringify(rejected.response.body).toLowerCase().includes("api key"),
      "AWS must not fall back to pasted credentials when DCR refuses the callback",
    );

    fixture.setCallbacksAllowed(true);
    const ownerAttempt = yield* start(actors.owner, ownerConnection);
    equal(ownerAttempt.response.status, 200, "Start the owner's AWS OAuth flow");
    check(ownerAttempt.body, "AWS OAuth start omitted its response body");
    equal(ownerAttempt.body.redirectUri, fixture.callbackUri(), "AWS registration and start must use the same callback");
    equal(fixture.callbackUri(), fixture.expectedCallback,
      "The app must request AWS's approved, provider-owned loopback URI");
    const registeredCallback = new URL(fixture.callbackUri());
    equal(registeredCallback.protocol, "http:", "AWS's registered loopback callback uses HTTP");
    check(["localhost", "127.0.0.1", "[::1]"].includes(registeredCallback.hostname),
      "AWS's registered callback must be loopback");
    check(Date.parse(ownerAttempt.body.expiresAt) > Date.now(), "Sign-in attempt must have a future expiry");
    const ownerCallback = yield* Effect.promise(() => fixture.approve(ownerAttempt.body.authorizationUrl, "owner"));

    const wrongOrigin = new URL(ownerCallback);
    wrongOrigin.hostname = wrongOrigin.hostname === "localhost" ? "127.0.0.1" : "localhost";
    yield* refused(actors.owner, ownerConnection, wrongOrigin.href, "Wrong loopback host");

    const wrongPort = new URL(ownerCallback);
    wrongPort.port = String(registeredCallback.port === "65535" ? 43118 : Number(registeredCallback.port) + 1);
    yield* refused(actors.owner, ownerConnection, wrongPort.href, "Wrong loopback port");

    const wrongPath = new URL(ownerCallback);
    wrongPath.pathname = "/oauth/not-the-callback";
    yield* refused(actors.owner, ownerConnection, wrongPath.href, "Wrong callback path");

    const wrongState = new URL(ownerCallback);
    wrongState.searchParams.set("state", "tampered-state");
    yield* refused(actors.owner, ownerConnection, wrongState.href, "Wrong OAuth state");

    const ownerAccount = checked(
      yield* complete(actors.owner, ownerConnection, ownerCallback),
      200,
      "Complete the owner's full callback",
    );
    check(ownerAccount.id, "OAuth completion did not create a saved account");

    const secondOwnerConnection = yield* connection(actors.owner);
    const secondOwnerAttempt = yield* start(actors.owner, secondOwnerConnection);
    equal(secondOwnerAttempt.response.status, 200, "Start the owner's fresh OAuth flow");
    yield* refused(actors.owner, secondOwnerConnection, ownerCallback, "Replayed callback on a new connection");
    const secondOwnerCallback = yield* Effect.promise(() =>
      fixture.approve(secondOwnerAttempt.body.authorizationUrl, "owner"),
    );
    const secondOwner = checked(
      yield* complete(actors.owner, secondOwnerConnection, secondOwnerCallback),
      200,
      "Complete a fresh owner callback after rejecting replay",
    );
    check(secondOwner.id !== ownerAccount.id, "A fresh connection should save a distinct account");

    const memberConnection = yield* connection(actors.member);
    const memberAttempt = yield* start(actors.member, memberConnection);
    equal(memberAttempt.response.status, 200, "Start the member's AWS OAuth flow");
    yield* refused(actors.member, memberConnection, secondOwnerCallback, "Callback issued to another person");
    const memberCallback = yield* Effect.promise(() => fixture.approve(memberAttempt.body.authorizationUrl, "member"));
    const memberAccount = checked(
      yield* complete(actors.member, memberConnection, memberCallback),
      200,
      "Complete the member's personal AWS callback",
    );
    check(memberAccount.id !== ownerAccount.id, "People must receive separate personal AWS accounts");

    const ownerRequirement = requirementPath(`${prefix}/apps/${app.id}`, "user", "aws");
    const linkedOwnerAccounts = () => Effect.gen(function* () {
      const response = yield* request(actors.owner, "GET", ownerRequirement);
      const requirement = checked(response, 200, "Read linked owner AWS accounts");
      return requirement.accounts.filter((entry) => entry.linked).map((entry) => entry.account.id);
    });
    const linksBeforeReconnect = yield* linkedOwnerAccounts();
    check(linksBeforeReconnect.includes(ownerAccount.id), "The first owner AWS account must be linked before reconnect");
    check(linksBeforeReconnect.includes(secondOwner.id), "The second owner AWS account must remain linked before reconnect");

    const reconnectResponse = yield* request(
      actors.owner,
      "POST",
      connectionsPath(`${prefix}/apps/${app.id}`, "user", "aws"),
      { account: ownerAccount.id },
    );
    const reconnectConnection = checked(reconnectResponse, 200, "Create a reconnect for the existing AWS account");
    const reconnectAttempt = yield* start(actors.owner, reconnectConnection);
    equal(reconnectAttempt.response.status, 200, "Start reconnecting the existing AWS account");
    const reconnectCallback = yield* Effect.promise(() =>
      fixture.approve(reconnectAttempt.body.authorizationUrl, "owner-reconnected"),
    );
    const reconnectedAccount = checked(
      yield* complete(actors.owner, reconnectConnection, reconnectCallback),
      200,
      "Complete OAuth reconnect for the existing AWS account",
    );
    equal(reconnectedAccount.id, ownerAccount.id, "Reconnect must preserve the saved AWS account ID");
    const linksAfterReconnect = yield* linkedOwnerAccounts();
    equal(linksAfterReconnect, linksBeforeReconnect, "Reconnect must preserve all existing user requirement links");

    return {
      callback: fixture.callbackUri(),
      callbackRefusalStopsDcr: true,
      publicPkceDcr: true,
      noOAuthScopeStrings: true,
      malformedCallbacksRejected: ["origin", "port", "path", "state"],
      replayRejected: true,
      crossUserCallbackRejected: true,
      reconnectPreservedAccount: true,
      reconnectPreservedLinks: true,
      ownerAccount: ownerAccount.id,
      memberAccount: memberAccount.id,
    };
  });
}
