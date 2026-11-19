import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { OAuthWireFailure } from "../../.upstream/apps/hosted/cloud/src/contracts/oauth-wire.ts";
import { makeOAuthProtocol } from "../../.upstream/packages/sdk/src/implementation/oauth-protocol-native.ts";
import { OAuthProtocolFailed } from "../../.upstream/packages/sdk/src/implementation/oauth-protocol-shared.ts";
import { defaultUrlPolicy } from "../../.upstream/packages/utils/src/url-policy.ts";
import { assertOAuthClientId } from "../oauth-client-config.ts";

const marker = "synthetic-private-marker";
const redirectUri = "https://executor.example.test/api/oauth/callback";
const server = {
  issuer: "https://auth.example.test",
  authorization_endpoint: "https://auth.example.test/authorize",
  token_endpoint: "https://auth.example.test/token",
  registration_endpoint: "https://auth.example.test/register",
  token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
};

/** The native protocol over a recording transport: registration answers `registered`. */
const protocol = (registered?: Record<string, unknown>) => {
  const requests: string[] = [];
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      return HttpClientResponse.fromWeb(
        request,
        path === "/register" && registered !== undefined
          ? Response.json(registered, { status: 201 })
          : new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      );
    }),
  );
  return {
    requests,
    oauth: makeOAuthProtocol({ clientName: "Executor", httpClient, urlPolicy: defaultUrlPolicy }),
  };
};
type Authorize = ReturnType<ReturnType<typeof protocol>["oauth"]["authorize"]>;

/** The named refusal, which keeps no part of the refused value. */
const refusal = async (authorize: Authorize) => {
  const result = await Effect.runPromise(Effect.result(authorize));
  assert.ok(Result.isFailure(result), "authorize built a URL carrying the client secret");
  const failure = result.failure;
  assert.ok(failure instanceof OAuthProtocolFailed);
  assert.equal(failure.reason, "client_id_looks_like_secret");
  for (const text of [JSON.stringify(failure), failure.message, String(failure.stack)])
    assert.ok(!text.includes(marker));
  return failure;
};

test("the hosted operator's client is refused before its anonymous check and across the wire", async () => {
  const { oauth, requests } = protocol();
  for (const prefix of ["pscale_app_secret_", "GOCSPX-"]) {
    const failure = await refusal(
      oauth.authorize({
        server,
        client: {
          client_id: `${prefix}${marker}`,
          token_endpoint_auth_method: "client_secret_post",
          client_secret: "different-synthetic-secret",
        },
        redirectUri,
        scopes: ["read"],
        checkAuthorization: true,
      }),
    );
    // The cloud host runs authorization in its OAuth wire Worker and returns failures encoded.
    const wire = await Effect.runPromise(Schema.encodeEffect(OAuthWireFailure)(failure));
    assert.ok(!JSON.stringify(wire).includes(marker));
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(OAuthWireFailure)(wire));
    assert.equal(decoded.reason, "client_id_looks_like_secret");
  }
  assert.deepEqual(requests, []);
});

test("a client secret pasted as a bring-your-own client ID never reaches the browser's URL", async () => {
  const { oauth, requests } = protocol();
  await refusal(
    oauth.authorize({
      server,
      client: { client_id: `GOCSPX-${marker}`, token_endpoint_auth_method: "none" },
      redirectUri,
      scopes: [],
    }),
  );
  await refusal(
    oauth.authorize({
      server,
      client: {
        client_id: `  pscale_app_secret_${marker}\n`,
        token_endpoint_auth_method: "client_secret_post",
        client_secret: "different-synthetic-secret",
      },
      redirectUri,
      scopes: ["read"],
    }),
  );
  assert.deepEqual(requests, []);
});

test("a dynamically registered client with a secret-shaped ID is refused at authorization", async () => {
  const clientId = `pscale_app_secret_${marker}`;
  const { oauth, requests } = protocol({
    client_id: clientId,
    token_endpoint_auth_method: "none",
    redirect_uris: [redirectUri],
  });
  const registered = await Effect.runPromise(
    oauth.register(server, new URL(redirectUri), ["read"]),
  );
  assert.equal(registered.client_id, clientId);
  await refusal(oauth.authorize({ server, client: registered, redirectUri, scopes: ["read"] }));
  assert.deepEqual(requests, ["POST /register"]);
});

test("authorization refuses exactly the client IDs the hosted deploy check refuses", async () => {
  const { oauth } = protocol();
  for (const clientId of [
    "pscale_app_secret_fixture",
    "GOCSPX-fixture",
    " GOCSPX-fixture\t",
    "pscale_app_fixture",
    "gocspx-fixture",
    "fixture-GOCSPX-",
    "opaque-client",
    "0123456789abcdef",
  ]) {
    const deploy = (() => {
      try {
        assertOAuthClientId("Fixture", clientId);
        return "accepted";
      } catch {
        return "refused";
      }
    })();
    const result = await Effect.runPromise(
      Effect.result(
        oauth.authorize({
          server,
          client: { client_id: clientId, token_endpoint_auth_method: "none" },
          redirectUri,
          scopes: [],
        }),
      ),
    );
    assert.equal(
      Result.isSuccess(result) ? "accepted" : "refused",
      deploy,
      JSON.stringify(clientId),
    );
    if (Result.isSuccess(result))
      assert.equal(
        new URL(result.success.authorizationUrl).searchParams.get("client_id"),
        clientId,
      );
  }
});
