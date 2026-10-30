import assert from "node:assert/strict";
import { zendeskScopes } from "./zendesk-fixture.mjs";
import { deployZendeskApps } from "./zendesk-apps.mjs";

const sortedScopes = [...zendeskScopes].sort();
const expectedScopes = (url) => (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean).sort();
const responseTag = (response) => typeof response.body?._tag === "string" ? response.body._tag : undefined;

/** Own the two-site app deployment, per-issuer client selection, callback, and token-exchange proof. */
export function proveZendeskOAuth({ Effect, request, checked, actors, prefix, callback, fixtures, catalog, record }) {
  return Effect.gen(function* () {
    const responseTagOf = (value) => responseTag(value);
    const { apps, clients } = yield* deployZendeskApps({
      Effect, request, checked, actors, prefix, fixtures, catalog, record,
    });
    const users = [
      { siteId: "site-a", mode: "public", actor: actors.owner },
      { siteId: "site-a", mode: "confidential", actor: actors.member },
      { siteId: "site-b", mode: "public", actor: actors.admin },
      { siteId: "site-b", mode: "confidential", actor: actors.owner },
      { siteId: "site-a", mode: "hosted", actor: actors.admin },
      { siteId: "site-b", mode: "hosted", actor: actors.member },
    ];

    for (const flow of users) {
      const site = fixtures.site(flow.siteId);
      const app = apps.get(flow.siteId);
      const connection = checked(yield* request(flow.actor, "POST",
        `${app.path}/accounts/user/zendesk/connections`, {
          destination: { kind: "personal" },
          site: site.origin,
        }), 200, `Create ${flow.mode} Zendesk connection for ${site.id}`);
      assert.equal(connection.target.site, site.origin, "Connection creation must freeze the requested site");
      flow.site = site;
      flow.app = app;
      flow.connection = connection;
      flow.startPath = `${prefix}/connections/${connection.id}/oauth/start`;
      flow.completePath = `${prefix}/connections/${connection.id}/oauth/complete`;
    }

    assert.equal(new Set(users.map((flow) => flow.connection.id)).size, users.length,
      "Each synthetic sign-in must have a distinct connection");
    assert.equal(new Set([...clients.values()].map((client) => client.id)).size, fixtures.sites.length,
      "Each site must have a distinct stored public client");
    const flowByKey = new Map();
    for (const flow of users) flowByKey.set(`${flow.siteId}:${flow.mode}`, flow);

    const setup = (flow, selectedSite) => Effect.gen(function* () {
      const response = yield* request(flow.actor, "GET",
        `${prefix}/connections/${flow.connection.id}/oauth/oauth/setup?site=${encodeURIComponent(selectedSite.origin)}`);
      assert.equal(response.status, 200, `OAuth setup failed for ${selectedSite.id}`);
      return response.body;
    });

    for (const site of fixtures.sites) {
      const flow = flowByKey.get(`${site.id}:public`);
      const options = yield* setup(flow, site);
      const offered = options.clients ?? [];
      assert.deepEqual(offered.map((client) => client.id), [clients.get(site.id).id],
        `OAuth setup for ${site.id} must offer only its stored public client`);
      assert.equal(options.issuer, `${site.origin}/oauth/tokens`, `OAuth setup must use the exact ${site.id} issuer`);
      const peer = fixtures.sites.find((candidate) => candidate.id !== site.id);
      const poisoned = yield* setup(flow, peer);
      assert.equal(poisoned.issuer, `${site.origin}/oauth/tokens`, "Caller query must not retarget the frozen connection site");
      const wrongOptions = yield* setup(flowByKey.get(`${peer.id}:public`), peer);
      record("oauth-setup-peer-boundary", {
        site: site.id,
        peerSite: peer.id,
        peerIssuerMatches: wrongOptions.issuer === `${peer.origin}/oauth/tokens`,
        peerClientCount: wrongOptions.clients?.length,
        ownClientOfferedToPeer: wrongOptions.clients?.some((client) => client.id === clients.get(site.id).id),
      });
      assert.equal(wrongOptions.issuer, `${peer.origin}/oauth/tokens`, "Peer setup must resolve its frozen site issuer");
      assert.equal(wrongOptions.clients.some((client) => client.id === clients.get(site.id).id), false,
        `OAuth setup for ${peer.id} must not offer ${site.id}'s stored client`);
      record("oauth-setup-client-isolated", {
        site: site.id,
        host: site.host,
        issuer: options.issuer,
        issuerOrigin: new URL(options.issuer).origin,
        offeredClientCount: offered.length,
        peerClientOffered: false,
      });
    }

    for (const flow of users) {
      const site = flow.site;
      const other = fixtures.sites.find((candidate) => candidate.id !== site.id);
      const client = flow.mode === "public"
        ? { id: clients.get(site.id).id }
        : flow.mode === "confidential"
          ? fixtures.client(site.id, "confidential")
          : undefined;
      flow.client = client;
      const label = `Synthetic Zendesk ${site.id} ${flow.mode}`;
      if (flow.mode === "public") {
        const peerClient = clients.get(other.id);
        const beforePeerSelection = fixtures.observations().filter((event) =>
          event.phase === "authorization" || event.phase.startsWith("token_"),
        ).length;
        const peerSelection = yield* request(flow.actor, "POST", flow.startPath, {
          method: "oauth",
          label,
          client: { id: peerClient.id },
        });
        record("peer-site-stored-client-denied", {
          site: site.id,
          host: site.host,
          peerSite: other.id,
          status: peerSelection.status,
          errorTag: responseTagOf(peerSelection),
        });
        assert.equal(peerSelection.status, 404,
          `A ${other.id} stored public client must not be selectable for ${site.id}`);
        assert.equal(fixtures.observations().filter((event) =>
          event.phase === "authorization" || event.phase.startsWith("token_"),
        ).length, beforePeerSelection, "Refused client selection must not authorize or exchange tokens");
      }

      const startBody = { method: "oauth", label, ...(client === undefined ? {} : { client }) };
      const retargeted = yield* request(flow.actor, "POST", flow.startPath, {
        ...startBody,
        site: other.origin,
      });
      let started;
      if (retargeted.status === 200) {
        started = retargeted.body;
        assert.equal(new URL(started.authorizationUrl).origin, site.origin,
          "An OAuth start site field must not retarget the saved connection");
        record("oauth-start-retarget-ignored", {
          site: site.id,
          host: site.host,
          attemptedPeerSite: other.id,
          authorizationOrigin: new URL(started.authorizationUrl).origin,
        });
      } else {
        assert.ok(retargeted.status === 400 || retargeted.status === 422,
          `Unexpected OAuth start retarget status ${retargeted.status}`);
        record("oauth-start-retarget-rejected", {
          site: site.id,
          host: site.host,
          attemptedPeerSite: other.id,
          status: retargeted.status,
          errorTag: responseTagOf(retargeted),
        });
        started = checked(yield* request(flow.actor, "POST", flow.startPath, startBody), 200,
          `Start ${flow.mode} Zendesk OAuth at ${site.id}`);
      }

      const authorization = new URL(started.authorizationUrl);
      assert.equal(authorization.origin, site.origin);
      assert.equal(authorization.pathname, "/oauth/authorizations/new");
      assert.equal(started.redirectUri, callback);
      assert.equal(authorization.searchParams.get("redirect_uri"), callback);
      assert.equal(authorization.searchParams.get("response_type"), "code");
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authorization.searchParams.get("code_challenge"));
      assert.deepEqual(expectedScopes(authorization), sortedScopes);
      assert.equal(authorization.searchParams.has("client_secret"), false);
      assert.equal(
        authorization.searchParams.get("client_id"),
        fixtures.client(site.id, flow.mode).clientId,
        `${flow.mode} flow uses the client configured for ${site.id}`,
      );
      if (flow.mode === "hosted")
        assert.equal(Object.hasOwn(startBody, "client"), false,
          "The hosted first-party client is selected by the host, not supplied by the caller");
      flow.started = started;
      flow.callbackUrl = yield* Effect.promise(async () => {
        const response = await fetch(started.authorizationUrl, { redirect: "manual" });
        assert.equal(response.status, 302, `Zendesk ${site.id} authorization fixture refused the request`);
        const location = response.headers.get("location");
        assert.ok(location, "Zendesk authorization fixture omitted its callback");
        const returned = new URL(location);
        assert.equal(returned.origin, new URL(callback).origin);
        assert.equal(returned.pathname, new URL(callback).pathname);
        assert.equal(returned.searchParams.get("state"), authorization.searchParams.get("state"));
        return returned.href;
      });
      const authorizationEvent = fixtures.observations().filter((event) => event.phase === "authorization").at(-1);
      assert.equal(authorizationEvent?.site, site.id,
        `Authorization for ${flow.mode} ${site.id} must reach the frozen site`);
      assert.equal(authorizationEvent?.flowMode, flow.mode);
      record("authorization-start", {
        site: site.id,
        host: site.host,
        endpoint: authorization.pathname,
        authMethod: flow.mode === "public" ? "none" : "client_secret_post",
        scopes: expectedScopes(authorization),
        pkceMethod: authorization.searchParams.get("code_challenge_method"),
        pkceChallengePresent: true,
        clientSecretInUrl: false,
      });
    }

    const siteAPublic = flowByKey.get("site-a:public");
    const siteBPublic = flowByKey.get("site-b:public");
    const exchangesBeforeInjection = fixtures.observations().filter((event) => event.phase.startsWith("token_")).length;
    const crossCallback = yield* request(siteAPublic.actor, "POST", siteAPublic.completePath, {
      callbackUrl: siteBPublic.callbackUrl,
      site: siteBPublic.site.origin,
    });
    record("peer-site-callback-denied", {
      site: siteAPublic.site.id,
      host: siteAPublic.site.host,
      peerSite: siteBPublic.site.id,
      status: crossCallback.status,
      errorTag: responseTagOf(crossCallback),
    });
    assert.ok(crossCallback.status >= 400 && crossCallback.status < 500,
      "A callback from another Zendesk site must not complete this connection");
    assert.equal(fixtures.observations().filter((event) => event.phase.startsWith("token_")).length,
      exchangesBeforeInjection, "A peer callback must be rejected before token exchange");

    const poisonedCallback = new URL(siteAPublic.callbackUrl);
    poisonedCallback.searchParams.set("site", siteBPublic.site.origin);
    const beforePoisonedCompletion = fixtures.observations().filter((event) => event.phase.startsWith("token_")).length;
    const poisoned = yield* request(siteAPublic.actor, "POST", siteAPublic.completePath, {
      callbackUrl: poisonedCallback.href,
      site: siteBPublic.site.origin,
    });
    let poisonedAccount;
    if (poisoned.status === 200) {
      poisonedAccount = poisoned.body;
      assert.equal(fixtures.observations().filter((event) => event.phase === "token_exchange" && event.site === "site-b").length, 0,
        "Callback site input must not send credentials or codes to the peer site");
      record("callback-site-input-ignored", {
        site: siteAPublic.site.id,
        host: siteAPublic.site.host,
        attemptedPeerSite: siteBPublic.site.id,
      });
    } else {
      assert.ok(poisoned.status === 400 || poisoned.status === 422,
        `Unexpected callback site injection status ${poisoned.status}`);
      const afterPoisonedCompletion = fixtures.observations().filter((event) => event.phase.startsWith("token_")).length;
      assert.equal(fixtures.observations().filter((event) => event.phase === "token_exchange" && event.site === "site-b").length, 0,
        "Callback site input must not send credentials or codes to the peer site");
      if (afterPoisonedCompletion === beforePoisonedCompletion) {
        poisonedAccount = checked(yield* request(siteAPublic.actor, "POST", siteAPublic.completePath, {
          callbackUrl: siteAPublic.callbackUrl,
        }), 200, "Complete valid site-a public callback");
      } else {
        const restarted = checked(yield* request(siteAPublic.actor, "POST", siteAPublic.startPath, {
          method: "oauth",
          label: "Synthetic Zendesk site-a public retry",
          client: { id: clients.get("site-a").id },
        }), 200, "Restart site-a public OAuth after callback-site refusal");
        const retryCallback = yield* Effect.promise(async () => {
          const response = await fetch(restarted.authorizationUrl, { redirect: "manual" });
          assert.equal(response.status, 302);
          return response.headers.get("location");
        });
        assert.ok(retryCallback);
        poisonedAccount = checked(yield* request(siteAPublic.actor, "POST", siteAPublic.completePath, {
          callbackUrl: retryCallback,
        }), 200, "Complete fresh site-a public callback");
      }
      record("callback-site-input-rejected", {
        site: siteAPublic.site.id,
        host: siteAPublic.site.host,
        attemptedPeerSite: siteBPublic.site.id,
        status: poisoned.status,
        errorTag: responseTagOf(poisoned),
      });
    }
    siteAPublic.account = poisonedAccount;
    assert.ok(fixtures.observations().some((event) =>
      event.phase === "token_exchange" && event.site === "site-a" && event.flowMode === "public",
    ), "The valid site-a public callback exchanges only at its frozen issuer");

    for (const flow of users) {
      if (flow === siteAPublic) continue;
      const beforeCompletion = fixtures.observations().length;
      const completed = checked(yield* request(flow.actor, "POST", flow.completePath, {
        callbackUrl: flow.callbackUrl,
      }), 200, `Complete ${flow.mode} Zendesk callback for ${flow.site.id}`);
      const completionEvents = fixtures.observations().slice(beforeCompletion);
      const exchanges = completionEvents.filter((event) => event.phase === "token_exchange");
      assert.equal(exchanges.length, 1, `OAuth completion exchanges once for ${flow.site.id}`);
      assert.equal(exchanges[0]?.site, flow.site.id,
        `OAuth completion for ${flow.site.id} must not place its code at the peer host`);
      assert.equal(exchanges[0]?.flowMode, flow.mode);
      flow.account = completed;
    }

    for (const [left, right] of [[
      flowByKey.get("site-a:public"), flowByKey.get("site-a:confidential"),
    ], [flowByKey.get("site-b:public"), flowByKey.get("site-b:confidential")]]) {
      const peer = yield* request(left.actor, "POST", `${prefix}/connections/${right.connection.id}/oauth/start`, {
        method: "oauth",
        label: "Peer Zendesk connection attempt",
      });
      record("peer-connection-denied", {
        site: left.site.id,
        host: left.site.host,
        status: peer.status,
        errorTag: responseTagOf(peer),
      });
      assert.ok(peer.status === 403 || peer.status === 404,
        "A Zendesk actor must not start a peer's connection");
    }
    return { users, flowByKey };
  });
}
