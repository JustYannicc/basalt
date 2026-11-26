import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import * as sdk from "../../.upstream/packages/sdk/src/core.ts";
import { defaultUrlPolicy } from "../../.upstream/packages/utils/src/url-policy.ts";
import {
  scopeListDigest,
  WholeListScopeIssuers,
} from "../../.upstream/packages/sdk/src/implementation/provider-oauth-scopes.ts";

/** A real sign-in through the SDK: does the saved grant record a whole-list request? */
const redirectUri = "https://executor.example.test/api/oauth/callback";
const owner = sdk.OwnerId.make("organization:whole-list");
const app = sdk.AppId.make("app_whole_list");
const issuer = "https://auth.example.test/tenant";
const server = {
  authorizationUrl: "https://auth.example.test/authorize",
  tokenUrl: "https://auth.example.test/token",
};
const published = ["read", "write", "billing"];
const unused = () => Effect.die("A sign-in reached app execution or file storage");
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
// Real encryption is the host's; sign-in only needs stored records to read back.
const credentials = {
  encrypt: (_identity: unknown, fields: Redacted.Redacted<sdk.JsonObject>) =>
    Effect.succeed(bytes(Redacted.value(fields))),
  decrypt: (_identity: unknown, stored: Redacted.Redacted<Uint8Array>) =>
    Effect.succeed(
      Redacted.make(JSON.parse(new TextDecoder().decode(Redacted.value(stored))) as sdk.JsonObject),
    ),
  fingerprint: (purpose: string, value: Redacted.Redacted<string>) =>
    Effect.succeed(
      createHash("sha256")
        .update(`${purpose}\0${Redacted.value(value)}`)
        .digest("hex"),
    ),
};

/**
 * Sign in to an app asking for `scopes` while `reviewed` is the marked issuer's reviewed list and
 * baseline, and return the grant as saved.
 */
const signIn = (scopes: readonly string[], reviewed: readonly string[] | undefined) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const database = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
        yield* database.migrate;
        const httpClient = HttpClient.make((request) =>
          Effect.sync(() => {
            const path = new URL(request.url).pathname;
            const answer =
              path === "/.well-known/oauth-authorization-server/tenant"
                ? Response.json({
                    issuer,
                    authorization_endpoint: server.authorizationUrl,
                    token_endpoint: server.tokenUrl,
                    registration_endpoint: "https://auth.example.test/register",
                    response_types_supported: ["code"],
                    code_challenge_methods_supported: ["S256"],
                    token_endpoint_auth_methods_supported: ["none"],
                    scopes_supported: published,
                  })
                : path === "/register"
                  ? Response.json(
                      {
                        client_id: "fixture-client",
                        token_endpoint_auth_method: "none",
                        redirect_uris: [redirectUri],
                      },
                      { status: 201 },
                    )
                  : path === "/token"
                    ? Response.json({
                        access_token: "synthetic-access",
                        token_type: "Bearer",
                        expires_in: 3600,
                        refresh_token: "synthetic-refresh",
                        scope: scopes.join(" "),
                      })
                    : new Response("not found", { status: 404 });
            return HttpClientResponse.fromWeb(request, answer);
          }),
        );
        const definition = {
          name: "Whole-list service",
          auth: {
            oauth: {
              type: "oauth2",
              ...server,
              scopes,
              response: {},
              issuer,
              authorizationServerMetadataUrl:
                "https://auth.example.test/.well-known/oauth-authorization-server/tenant",
            },
          },
        };
        const requirements = {
          accounts: {
            service: {
              scope: "app",
              provider: "prv_whole_list",
              cardinality: "one",
              contributed: false,
              definition,
            },
          },
        };
        yield* Schema.decodeUnknownEffect(sdk.AppRequirements)(requirements);
        yield* sql`insert into executor_providers (id, definition)
          values ('prv_whole_list', ${JSON.stringify(definition)})`;
        yield* sql`insert into executor_deployments
          (id, code, owner, build, requirements, created_at, source_commit, file_count)
          values ('dpl_whole_list', 'code_whole_list', ${owner}, 'bld_whole_list',
            ${JSON.stringify(requirements)}, now(), null, 1)`;
        yield* sql`insert into executor_apps
          (id, code, repository, owner, name, slug, active_deployment, copied_from, created_at)
          values (${app}, 'code_whole_list', null, ${owner}, 'Whole-list app', 'whole-list-app',
            'dpl_whole_list', null, now())`;
        const executor = yield* sdk.createExecutor({
          database,
          origin: "https://executor.example.test",
          credentials,
          git: {
            history: unused,
            create: unused,
            head: unused,
            read: unused,
            commit: unused,
            blob: unused,
            file: unused,
            request: unused,
          },
          blobs: {
            get: unused,
            exists: unused,
            put: unused,
            remove: unused,
            list: unused,
            stream: unused,
          },
          runtime: sdk.runtimeAdapter({
            build: unused,
            skills: unused,
            inspect: unused,
            index: unused,
            query: unused,
            mutate: unused,
            webhook: unused,
            workflow: unused,
            mcpApp: unused,
            call: unused,
            connect: unused,
            checkAccount: unused,
            migrate: unused,
          }),
          oauth: { clientName: "Executor", httpClient, urlPolicy: defaultUrlPolicy },
        });
        const connection = yield* executor.accountConnections.create({
          owner,
          target: { app, requirement: "service" },
        });
        const started = yield* executor.accountConnections.startOAuth({
          connection: connection.id,
          method: "oauth",
          redirectUri: sdk.HttpUrl.make(redirectUri),
        });
        assert.equal(started.status, "redirect");
        if (started.status !== "redirect") return undefined;
        const state = new URL(started.authorizationUrl).searchParams.get("state");
        assert.ok(state, "the authorization URL carries its state");
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "synthetic-code");
        callback.searchParams.set("state", state);
        yield* executor.accountConnections.completeOAuth({
          connection: connection.id,
          callbackUrl: Redacted.make(sdk.HttpUrl.make(callback.href)),
        });
        const [row] = yield* sql<{
          encrypted: Uint8Array;
        }>`select encrypted from executor_oauth_grants`;
        assert.ok(row, "the sign-in saved a grant");
        return JSON.parse(new TextDecoder().decode(row.encrypted)) as Record<string, unknown>;
      }).pipe(
        Effect.provideService(WholeListScopeIssuers, {
          issuers:
            reviewed === undefined
              ? []
              : [
                  {
                    issuer,
                    lists: [scopeListDigest(reviewed)],
                  },
                ],
        }),
      ),
    ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeCrypto.layer)),
  );

test("a sign-in asking for the marked issuer's whole reviewed list records it on its grant", async () => {
  const grant = await signIn(["read", "write"], ["read", "write"]);
  assert.deepEqual(grant?.requestedScopes, ["read", "write"]);
  assert.equal(grant?.requestedIssuerList, true);
});

test("a sign-in asking for less, or to an issuer the registry does not mark, records nothing", async () => {
  const narrow = await signIn(["read"], ["read", "write"]);
  assert.deepEqual(narrow?.requestedScopes, ["read"]);
  assert.equal("requestedIssuerList" in (narrow ?? {}), false);
  const unmarked = await signIn(["read", "write"], undefined);
  assert.equal("requestedIssuerList" in (unmarked ?? {}), false);
});
