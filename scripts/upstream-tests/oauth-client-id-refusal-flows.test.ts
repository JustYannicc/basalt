import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Effect, Redacted, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import * as sdk from "../../.upstream/packages/sdk/src/core.ts";
import {
  FirstPartyOAuthClient,
  OAuthSetupFailed,
} from "../../.upstream/packages/sdk/src/contracts/oauth.ts";
import { defaultUrlPolicy } from "../../.upstream/packages/utils/src/url-policy.ts";

/** What people and agents see of a secret entered as a client ID, through the SDK's own entry points. */
const marker = "synthetic-private-marker";
const redirectUri = "https://executor.example.test/api/oauth/callback";
const owner = sdk.OwnerId.make("organization:oauth-refusal");
const app = sdk.AppId.make("app_oauth_refusal");
const issuer = "https://auth.example.test/tenant";
const server = {
  authorizationUrl: "https://auth.example.test/authorize",
  tokenUrl: "https://auth.example.test/token",
};
const unused = () => Effect.die("A sign-in start reached app execution or file storage");
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
 * The operator's client as configuration supplies it, public when it runs the anonymous check,
 * which only public ones may. `signIn` decodes it the way the host does.
 */
const operator = (id: string, clientId: string, checked = false): unknown => ({
  id,
  label: `Fixture ${id}`,
  server,
  clientId,
  ...(checked
    ? { tokenEndpointAuthMethod: "none", checkAuthorization: true }
    : { tokenEndpointAuthMethod: "client_secret_post", clientSecret: "different-secret" }),
  setupInstructions: "Register {redirectUri} for the client {clientId}.",
  defaultScopes: ["read"],
  placement: { hosts: ["api.example.test"] },
});

interface Flow {
  readonly executor: sdk.Executor;
  readonly connection: sdk.AccountConnectionId;
  readonly sql: SqlClient.SqlClient;
  readonly requests: readonly string[];
}

/** One app requiring a fixture service, a pending connection for it and a recording transport. */
const signIn = <A, E>(
  setup: {
    readonly operators?: readonly unknown[];
    /** The service registers clients and answers registration with this. */
    readonly registered?: Record<string, unknown>;
  },
  work: (input: Flow) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const operators = yield* Effect.forEach(setup.operators ?? [], (client) =>
          Schema.decodeUnknownEffect(FirstPartyOAuthClient)(client),
        ).pipe(Effect.orDie);
        const database = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
        yield* database.migrate;
        const requests: string[] = [];
        const httpClient = HttpClient.make((request) =>
          Effect.sync(() => {
            const path = new URL(request.url).pathname;
            requests.push(`${request.method} ${path}`);
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
                  })
                : path === "/register" && setup.registered !== undefined
                  ? Response.json(setup.registered, { status: 201 })
                  : new Response("<html></html>", { headers: { "content-type": "text/html" } });
            return HttpClientResponse.fromWeb(request, answer);
          }),
        );
        const definition = {
          name: "Fixture service",
          auth: {
            oauth: {
              type: "oauth2",
              ...server,
              scopes: ["read"],
              response: {},
              ...(setup.registered === undefined
                ? {}
                : {
                    issuer,
                    authorizationServerMetadataUrl:
                      "https://auth.example.test/.well-known/oauth-authorization-server/tenant",
                  }),
            },
          },
        };
        const requirements = {
          accounts: {
            service: {
              scope: "app",
              provider: "prv_fixture",
              cardinality: "one",
              contributed: false,
              definition,
            },
          },
        };
        yield* Schema.decodeUnknownEffect(sdk.AppRequirements)(requirements);
        yield* sql`insert into executor_providers (id, definition)
          values ('prv_fixture', ${JSON.stringify(definition)})`;
        yield* sql`insert into executor_deployments
          (id, code, owner, build, requirements, created_at, source_commit, file_count)
          values ('dpl_fixture', 'code_fixture', ${owner}, 'bld_fixture',
            ${JSON.stringify(requirements)}, now(), null, 1)`;
        yield* sql`insert into executor_apps
          (id, code, repository, owner, name, slug, active_deployment, copied_from, created_at)
          values (${app}, 'code_fixture', null, ${owner}, 'Fixture app', 'fixture-app',
            'dpl_fixture', null, now())`;
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
          oauth: {
            clientName: "Executor",
            httpClient,
            urlPolicy: defaultUrlPolicy,
            firstPartyClients: operators,
          },
        });
        const connection = yield* executor.accountConnections.create({
          owner,
          target: { app, requirement: "service" },
        });
        return yield* work({ executor, connection: connection.id, sql, requests });
      }),
    ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeCrypto.layer)),
  );

const leaks = (value: unknown) =>
  [JSON.stringify(value), String(value), value instanceof Error ? String(value.stack) : ""].some(
    (text) => text.includes(marker),
  );

/** A refused start: the existing client-entry failure, no attempt kept and nothing echoed. */
const refusedStart = (input: Flow, client?: typeof sdk.StartConnectionOAuth.Type.client) =>
  Effect.gen(function* () {
    const started = yield* input.executor.accountConnections
      .startOAuth({
        connection: input.connection,
        method: "oauth",
        redirectUri: sdk.HttpUrl.make(redirectUri),
        ...(client === undefined ? {} : { client }),
      })
      .pipe(Effect.result);
    assert.ok(Result.isFailure(started), "sign-in started with a secret as the client ID");
    const failure = started.failure;
    assert.ok(Schema.is(OAuthSetupFailed)(failure), String(failure));
    assert.equal(failure.reason, "invalid_client");
    assert.ok(!leaks(failure));
    const shown = yield* input.executor.accountConnections.get({ connection: input.connection });
    assert.ok(!leaks(shown), "the recorded sign-in failure quotes the secret");
    const attempts = yield* input.sql<{ readonly count: number }>`
      select count(*)::int as count from executor_oauth_attempts`;
    assert.equal(attempts[0]?.count, 0);
    assert.ok(!input.requests.includes("GET /authorize"));
  });

const setupOf = (input: Flow) =>
  input.executor.accountConnections.oauthSetup({
    owner,
    connection: input.connection,
    method: "oauth",
    redirectUri: sdk.HttpUrl.make(redirectUri),
  });

for (const [shape, checked] of [
  ["without an anonymous check", false],
  ["with an anonymous check", true],
] as const) {
  test(`an operator client ${shape} whose ID is a secret is unavailable and never shown`, () =>
    signIn(
      {
        operators: [
          operator("secret-shaped", `GOCSPX-${marker}`, checked),
          operator("opaque", "opaque-operator-client"),
        ],
      },
      (input) =>
        Effect.gen(function* () {
          const setup = yield* setupOf(input);
          assert.ok(!leaks(setup), "the connect form shows the secret");
          assert.equal(setup.firstParty?.label, "Fixture opaque");
          const views = setup.operatorClients ?? [];
          assert.deepEqual(
            views.map((view) => [view.id, view.available]),
            [
              ["secret-shaped", false],
              ["opaque", true],
            ],
          );
          // Automatic sign-in uses the next available operator client.
          const started = yield* input.executor.accountConnections.startOAuth({
            connection: input.connection,
            method: "oauth",
            redirectUri: sdk.HttpUrl.make(redirectUri),
          });
          assert.equal(started.status, "redirect");
          assert.ok(!leaks(started));
          if (started.status === "redirect")
            assert.equal(
              new URL(started.authorizationUrl).searchParams.get("client_id"),
              "opaque-operator-client",
            );
          assert.ok(!input.requests.includes("GET /authorize"));
        }),
    ));

  test(`an operator's only client ${shape} with a secret as its ID asks for a client`, () =>
    signIn(
      { operators: [operator("secret-shaped", `pscale_app_secret_${marker}`, checked)] },
      (input) =>
        Effect.gen(function* () {
          const setup = yield* setupOf(input);
          assert.ok(!leaks(setup));
          assert.equal(setup.firstParty, undefined);
          assert.equal(setup.mode, "client-required");
          yield* refusedStart(input);
        }),
    ));
}

test("an entered client ID that is a secret is refused as the client the service rejects", () =>
  signIn({}, (input) => refusedStart(input, { clientId: `GOCSPX-${marker}` })));

test("a saved client whose ID is a secret is refused when a sign-in uses it", () =>
  signIn({}, (input) =>
    Effect.gen(function* () {
      const setup = yield* setupOf(input);
      assert.equal(setup.grant, "authorization_code");
      if (setup.grant !== "authorization_code") return;
      const saved = yield* input.executor.oauthClients.register({
        owner,
        issuer: setup.issuer,
        clientId: `pscale_app_secret_${marker}`,
        clientSecret: Redacted.make("different-synthetic-secret"),
      });
      yield* refusedStart(input, { id: saved.id });
    }),
  ));

test("a registered client issued a secret-shaped ID is refused before the browser opens", () =>
  signIn(
    {
      registered: {
        client_id: `GOCSPX-${marker}`,
        token_endpoint_auth_method: "none",
        redirect_uris: [redirectUri],
      },
    },
    (input) =>
      Effect.gen(function* () {
        const setup = yield* setupOf(input);
        assert.equal(setup.mode, "automatic");
        yield* refusedStart(input);
        assert.ok(input.requests.includes("POST /register"));
      }),
  ));
