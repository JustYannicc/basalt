import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Crypto, Effect, Redacted, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { providerDeclaration } from "../../.upstream/packages/apps/src/implementation/host.ts";
import * as sdk from "../../.upstream/packages/sdk/src/core.ts";
import { accountSignInState } from "../../.upstream/packages/sdk/src/implementation/account-sign-in.ts";
import { ownedAccount } from "../../.upstream/packages/sdk/src/implementation/accounts.ts";
import { database } from "../../.upstream/packages/sdk/src/implementation/database.ts";
import { makeOAuth } from "../../.upstream/packages/sdk/src/implementation/oauth.ts";
import {
  asksWholeList as decide,
  scopeListDigest,
  WholeListScopeIssuers,
} from "../../.upstream/packages/sdk/src/implementation/provider-oauth-scopes.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { defaultUrlPolicy } from "../../.upstream/packages/utils/src/url-policy.ts";
import { catalogProvider, catalogSource, providers, run } from "./cloudflare-family-fixture.ts";

/** A reviewed issuer as the generator reads it: its lists, before they are digested. */
type WholeListIssuer = {
  issuer: string;
  scopes: readonly string[];
  baseline: readonly string[];
  /** Lists reviewed between the baseline and today's. */
  history?: readonly (readonly string[])[];
};
/** The issuers as the SDK carries them: each list replaced by its digest. */
const digested = (issuers: readonly WholeListIssuer[]) =>
  issuers.map(({ issuer, scopes, baseline, history = [] }) => ({
    issuer,
    lists: [...new Set([baseline, ...history, scopes].map(scopeListDigest))],
  }));

// Cloudflare's reviewed issuer document, as a grant keeps it from discovery at its sign-in.
const issuer = JSON.parse(
  readFileSync(
    new URL("../../src/catalog/cloudflare.oauth-metadata.json", import.meta.url),
    "utf8",
  ),
) as {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported: string[];
};
const reviewed = issuer.scopes_supported;
const added = ["billing:read", "billing:write"];
/** What the Cloudflare app asked for before carry 0541 requested the issuer's whole list. */
const beforeFullAccess = ["user:read", "account:read", "offline_access"];
const owner = sdk.OwnerId.make("organization:team-a");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** A stored record as JSON fields, the shape the plain credentials above write. */
const decodeRecord = (bytes: Uint8Array) => {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
};
// Real encryption is the host's; these paths only need stored records to read back.
const plain: sdk.Credentials = {
  encrypt: (_identity, fields) => Effect.succeed(encode(Redacted.value(fields))),
  decrypt: (_identity, bytes) =>
    Effect.succeed(
      Redacted.make(JSON.parse(new TextDecoder().decode(Redacted.value(bytes))) as sdk.JsonObject),
    ),
  fingerprint: (purpose, value) =>
    Effect.succeed(
      createHash("sha256")
        .update(`${purpose}\0${Redacted.value(value)}`)
        .digest("hex"),
    ),
};
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
/** Cloudflare's token endpoint, answering a renewal with the scopes the grant holds. */
const renewals: string[] = [];
const httpClient = HttpClient.make((request) =>
  Effect.sync(() => {
    renewals.push(`${request.method} ${new URL(request.url).pathname}`);
    return HttpClientResponse.fromWeb(
      request,
      Response.json({
        access_token: "renewed-access",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "renewed-refresh",
        scope: reviewed.join(" "),
      }),
    );
  }),
);

/** A declaration's OAuth method, which every Cloudflare declaration has. */
const oauthOf = (definition: sdk.ProviderDefinition) => {
  const oauth = definition.auth.oauth;
  assert.ok(oauth?.type === "oauth2", "a Cloudflare declaration signs in with OAuth");
  return oauth;
};
/** A declaration that now asks for `scopes`. */
const asking = (
  definition: sdk.ProviderDefinition,
  scopes: readonly string[],
): sdk.ProviderDefinition => {
  const oauth = oauthOf(definition);
  assert.deepEqual(oauth.scopes, reviewed, "the declaration mirrors the reviewed issuer list");
  return { ...definition, auth: { ...definition.auth, oauth: { ...oauth, scopes: [...scopes] } } };
};

type Saved = {
  /** Shared grants are what grant reuse and family adoption leave between declarations. */
  readonly shared: boolean;
  /** The issuer's published list when the grant was signed in. */
  readonly offered?: readonly string[];
  /** What the grant asked for at sign-in; undefined for grants that recorded no request. */
  readonly asked?: readonly string[] | undefined;
  readonly granted?: readonly string[];
  /** The sign-in recorded that it asked for its reviewed issuer's whole list. */
  readonly marked?: boolean;
  /** What each declaration asks for now; by default the issuer's list grown by two. */
  readonly scopes?: readonly string[];
  /** The access token has expired, so resolving renews it. */
  readonly expired?: boolean;
};

/** The generated issuers once the reviewed list grew: today's list plus the two new scopes. */
const grownIssuers = [
  { issuer: issuer.issuer, scopes: [...reviewed, ...added], baseline: reviewed },
];
/**
 * One saved Cloudflare OAuth account with the rows sign-in writes, then what the account list
 * shows, whether each declaration's calls get a token, and the grant as stored afterwards.
 */
const observe = (saved: Saved, issuers: readonly WholeListIssuer[] = grownIssuers) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      const db = database(storage);
      const scopes = saved.scopes ?? [...reviewed, ...added];
      const declarations = [
        asking(yield* providerDeclaration(catalogProvider(catalogSource("cloudflare"))), scopes),
        asking(yield* providerDeclaration(providers.cloudflare), scopes),
      ];
      const provider = sdk.ProviderId.make("prv_cloudflare");
      yield* sql`insert into executor_providers (id,definition) values (${provider},${JSON.stringify(declarations[0])})`;
      const id = "acc_cloudflare";
      const grantId = saved.shared ? "acc_grant_cloudflare" : id;
      yield* sql`insert into executor_account_identities (id,owner,placement,issuer,subject,name,label,verified_at,created_at)
        values ('aid_cloudflare',${owner},${owner},'https://dash.cloudflare.com','cf-user','User','user@example.invalid',now(),now())`;
      yield* sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at,credential_generation,identity_id,oauth_grant_id)
        values (${id},${owner},${provider},'oauth',${id},${encode({})},now(),1,'aid_cloudflare',${saved.shared ? grantId : null})`;
      const asked = "asked" in saved ? saved.asked : reviewed;
      const grant = {
        grant: "authorization_code",
        server: {
          issuer: issuer.issuer,
          authorization_endpoint: issuer.authorization_endpoint,
          token_endpoint: issuer.token_endpoint,
          scopes_supported: saved.offered ?? reviewed,
        },
        client: {
          client_id: "https://executor.example.test/oauth/client.json",
          token_endpoint_auth_method: "none",
        },
        response: oauthOf(declarations[0]!).response,
        fields: { access_token: "synthetic-access" },
        refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + (saved.expired ? -60_000 : 3_600_000),
        generation: 1,
        identityId: "aid_cloudflare",
        identity: { issuer: "https://dash.cloudflare.com", subject: "cf-user" },
        ...(asked === undefined ? {} : { requestedScopes: asked }),
        grantedScopes: saved.granted ?? asked ?? reviewed,
        ...(saved.marked ? { requestedIssuerList: true } : {}),
      };
      yield* sql`insert into executor_oauth_grants (id,encrypted,status,updated_at,owner)
        values (${grantId},${encode(grant)},'ready_1',now(),${owner})`;
      const account = yield* ownedAccount(db, { account: sdk.AccountId.make(id), owner });
      const [row] = yield* sql<{ encrypted: Uint8Array; status: string }>`
        select encrypted, status from executor_oauth_grants where id = ${grantId}`;
      const oauth = makeOAuth(db, plain, crypto, {
        httpClient,
        clientName: "Executor",
        urlPolicy: defaultUrlPolicy,
      });
      const work = Effect.gen(function* () {
        const signIn = yield* accountSignInState(
          account,
          { id: provider, definition: declarations[0] },
          row,
          plain,
        );
        const calls = [];
        for (const definition of declarations) {
          const resolved = yield* Effect.result(oauth.resolve(account, definition));
          calls.push(
            Result.isSuccess(resolved)
              ? Redacted.value(resolved.success.fields).access_token
              : resolved.failure._tag,
          );
        }
        const [stored] = yield* sql<{ encrypted: Uint8Array }>`
          select encrypted from executor_oauth_grants where id = ${grantId}`;
        assert.ok(stored, "the grant is still saved");
        return { signIn, calls, stored: decodeRecord(stored.encrypted) };
      });
      return yield* work.pipe(
        Effect.provideService(WholeListScopeIssuers, { issuers: digested(issuers) }),
      );
    }),
  );

const saved = { state: "saved", reconnectAt: null };
const permissions = { state: "reconnect", reason: "permissions" };
const working = ["synthetic-access", "synthetic-access"];
const refused = ["OAuthReconnectRequired", "OAuthReconnectRequired"];

test("Cloudflare grants stay healthy and keep working when the issuer's list grows by two scopes", async () => {
  // Saved before grants recorded a whole-list request: they asked for the frozen baseline.
  for (const shared of [true, false]) {
    const observed = await observe({ shared });
    assert.deepEqual(observed.signIn, saved, `shared: ${shared}`);
    assert.deepEqual(observed.calls, working, `shared: ${shared}`);
  }
});

test("a grant signed in while the issuer already offered more than the provider asked stays healthy", async () => {
  // The lag window: the issuer already listed 405 while the provider asked for 403. Nothing the
  // rule reads differs from an earlier sign-in, so it must read the same once the provider grows.
  for (const shared of [true, false]) {
    const observed = await observe({ shared, offered: [...reviewed, ...added] });
    assert.deepEqual(observed.signIn, saved, `shared: ${shared}`);
    assert.deepEqual(observed.calls, working, `shared: ${shared}`);
  }
});

test("a recorded whole-list request survives the issuer removing one scope and adding another", async () => {
  const asked = reviewed.filter((scope) => scope !== "zone.write");
  const scopes = [...asked, ...added];
  const droppedIssuers = [{ issuer: issuer.issuer, scopes, baseline: reviewed }];
  const marked = await observe({ shared: true, asked, marked: true, scopes }, droppedIssuers);
  assert.deepEqual(marked.signIn, saved);
  assert.deepEqual(marked.calls, working);
  // Without the record, that request no longer covers the baseline, so it is held to everything.
  const unmarked = await observe({ shared: true, asked, scopes }, droppedIssuers);
  assert.deepEqual(unmarked.signIn, permissions);
  assert.deepEqual(unmarked.calls, refused);
  // An app version that has not followed the drop yet still asks for the baseline.
  const lagging = await observe(
    { shared: true, asked, marked: true, scopes: reviewed },
    droppedIssuers,
  );
  assert.deepEqual(lagging.signIn, saved);
  assert.deepEqual(lagging.calls, working);
});

test("a grant keeps working while its stored provider asks for a list the issuer has since cut", async () => {
  // The provider grew to the issuer's list plus two scopes, then the issuer dropped one; a stored
  // provider keeps asking for the grown list, which the history still names.
  const grown = [...reviewed, ...added];
  const cut = grown.filter((scope) => scope !== "zone.write");
  const history = [{ issuer: issuer.issuer, scopes: cut, baseline: reviewed, history: [grown] }];
  const observed = await observe({ shared: true, scopes: grown }, history);
  assert.deepEqual(observed.signIn, saved);
  assert.deepEqual(observed.calls, working);
  // Without that history entry the grown list is no reviewed list, so the grant is held to it.
  const forgotten = await observe({ shared: true, scopes: grown }, [
    { issuer: issuer.issuer, scopes: cut, baseline: reviewed },
  ]);
  assert.deepEqual(forgotten.signIn, permissions);
  assert.deepEqual(forgotten.calls, refused);
});

test("a grant without the record counts as whole-list only when it asked for exactly the baseline", async () => {
  // It asked for a later reviewed list, not the baseline; that list then grew by one more scope.
  const grown = [...reviewed, ...added];
  const issuers = [
    {
      issuer: issuer.issuer,
      scopes: [...grown, "synthetic:later"],
      baseline: reviewed,
      history: [grown],
    },
  ];
  const scopes = [...grown, "synthetic:later"];
  const unrecorded = await observe({ shared: true, asked: grown, scopes }, issuers);
  assert.deepEqual(unrecorded.signIn, permissions);
  assert.deepEqual(unrecorded.calls, refused);
  const recorded = await observe({ shared: true, asked: grown, marked: true, scopes }, issuers);
  assert.deepEqual(recorded.signIn, saved);
  assert.deepEqual(recorded.calls, working);
});

test("the three-scope grants from before full access keep their reconnect prompt and refusal", async () => {
  for (const scopes of [reviewed, [...reviewed, ...added]]) {
    const observed = await observe({ shared: true, asked: beforeFullAccess, scopes });
    assert.deepEqual(observed.signIn, permissions, `${scopes.length} scopes`);
    assert.deepEqual(observed.calls, refused, `${scopes.length} scopes`);
  }
  const own = await observe({ shared: false, asked: beforeFullAccess });
  assert.deepEqual(own.signIn, permissions);
});

test("a Cloudflare grant missing a scope it asked for still needs new permissions and is refused", async () => {
  const granted = reviewed.filter((scope) => scope !== "zone.write");
  for (const marked of [false, true]) {
    const observed = await observe({ shared: true, granted, marked });
    assert.deepEqual(observed.signIn, permissions, `marked: ${marked}`);
    assert.deepEqual(observed.calls, refused, `marked: ${marked}`);
  }
  // Only a shared grant is checked at credential use; Cloudflare refuses its own grant's calls.
  assert.deepEqual((await observe({ shared: false, granted })).signIn, permissions);
});

test("a scope the issuer does not publish stays required on a whole-list grant", async () => {
  // A second app sharing the grant adds a scope outside Cloudflare's reviewed list.
  const scopes = [...reviewed, "synthetic:unpublished"];
  for (const marked of [false, true]) {
    const observed = await observe({ shared: true, marked, scopes });
    assert.deepEqual(observed.signIn, permissions, `marked: ${marked}`);
    assert.deepEqual(observed.calls, refused, `marked: ${marked}`);
  }
});

test("the generated issuers name Cloudflare with its reviewed list and frozen baseline", async () => {
  const { issuers } = await Effect.runPromise(Effect.service(WholeListScopeIssuers));
  const baseline = JSON.parse(
    readFileSync(
      new URL("../../src/catalog/cloudflare.oauth-scope-baseline.json", import.meta.url),
      "utf8",
    ),
  ) as string[];
  // Preparation digests with its own copy of the SDK's function; this holds the two equal.
  assert.deepEqual(issuers, digested([{ issuer: issuer.issuer, scopes: reviewed, baseline }]));
});

test("a grant that recorded no request is held to every requested scope", async () => {
  const observed = await observe({ shared: true, asked: undefined, granted: reviewed });
  assert.deepEqual(observed.signIn, permissions);
  assert.deepEqual(observed.calls, refused);
});

test("an app asking for part of the issuer's list still asks to reconnect when it adds a scope", async () => {
  const observed = await observe({
    shared: true,
    asked: ["zone.read"],
    scopes: ["zone.read", "zone.write"],
  });
  assert.deepEqual(observed.signIn, permissions);
  assert.deepEqual(observed.calls, refused);
});

test("an issuer the registry does not mark keeps holding grants to every requested scope", async () => {
  const observed = await observe({ shared: true, marked: true }, []);
  assert.deepEqual(observed.signIn, permissions);
  assert.deepEqual(observed.calls, refused);
});

test("a renewal keeps the recorded whole-list request on the shared grant", async () => {
  renewals.length = 0;
  const observed = await observe({ shared: true, marked: true, expired: true });
  assert.deepEqual(renewals, ["POST /token"]);
  assert.deepEqual(observed.calls, ["renewed-access", "renewed-access"]);
  assert.equal(observed.stored.requestedIssuerList, true);
  assert.equal(observed.stored.refreshToken, "renewed-refresh");
});

test("a grant read by code that does not know the record decodes without it", async () => {
  // Grants decode with the record ignored when unknown, as releases before carry 0782 do, and
  // such a grant then counts as a whole-list request only through the baseline.
  const grant = {
    grant: "authorization_code",
    server: {
      issuer: issuer.issuer,
      authorization_endpoint: issuer.authorization_endpoint,
      token_endpoint: issuer.token_endpoint,
    },
    client: {
      client_id: "https://executor.example.test/oauth/client.json",
      token_endpoint_auth_method: "none",
    },
    response: {},
    fields: { access_token: "synthetic-access" },
    requestedScopes: reviewed,
    aRecordFromALaterRelease: true,
  };
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(sdk.OAuthGrant)(grant));
  assert.equal("aRecordFromALaterRelease" in decoded, false);
  assert.deepEqual("requestedScopes" in decoded ? decoded.requestedScopes : undefined, reviewed);
});

test("a sign-in records a whole-list request only for the marked issuer's whole reviewed list", () => {
  const asksWholeList = (
    server: { issuer: string },
    requested: readonly string[] | undefined,
    issuers: readonly WholeListIssuer[],
  ) => decide(server, requested, digested(issuers));
  const server = { issuer: issuer.issuer };
  // The reviewed list grew; an app version still asking for the earlier list counts too.
  assert.equal(asksWholeList(server, reviewed, grownIssuers), true);
  assert.equal(
    asksWholeList({ issuer: `${issuer.issuer}/` }, [...reviewed, ...added], grownIssuers),
    true,
  );
  // The issuer dropped a baseline scope: requests with and without it both count.
  const kept = reviewed.filter((scope) => scope !== "zone.write");
  const dropped = [{ issuer: issuer.issuer, scopes: kept, baseline: reviewed }];
  assert.equal(asksWholeList(server, kept, dropped), true);
  assert.equal(asksWholeList(server, reviewed, dropped), true);
  assert.equal(asksWholeList(server, ["zone.read"], grownIssuers), false);
  // A request beyond every reviewed list is no whole-list request either.
  assert.equal(
    asksWholeList(server, [...reviewed, ...added, "synthetic:unpublished"], grownIssuers),
    false,
  );
  assert.equal(asksWholeList(server, beforeFullAccess, grownIssuers), false);
  assert.equal(asksWholeList(server, undefined, grownIssuers), false);
  assert.equal(
    asksWholeList({ issuer: "https://auth.example.test" }, reviewed, grownIssuers),
    false,
  );
  // Without a baseline, the request must cover the reviewed list itself.
  const unfrozen = [{ issuer: issuer.issuer, scopes: reviewed, baseline: [] }];
  assert.equal(asksWholeList(server, reviewed, unfrozen), true);
  assert.equal(asksWholeList(server, kept, unfrozen), false);
});
