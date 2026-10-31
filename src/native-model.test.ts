import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest, type RouterEnv } from "./router.ts";
import {
  nativeAuthenticationHeader,
  nativeModelHeader,
  nativeModelPrefix,
} from "./pool/native-contract.ts";
import { openEnvelope } from "./pool/token.ts";

const signingKey = "ab".repeat(32);
const grant = {
  id: "native:client",
  userId: "user-a",
  clientId: "client-a",
  policy: { kind: "native", models: true, computer: "computer-a", pool: "pool-a" },
};

test("native model ingress checks the grant before asserting a device to the pool", async () => {
  let checks = 0,
    forwarded = 0;
  const env: RouterEnv = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: {
      fetch: async (request) => {
        checks++;
        assert.equal(new URL(request.url).pathname, "/api/auth/native/access");
        assert.equal(request.headers.get("authorization"), "Bearer native-opaque-token");
        assert.equal(request.headers.has("cookie"), false);
        return Response.json(grant);
      },
    },
    CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
    POOL_SERVICE: {
      fetch: async (request) => {
        forwarded++;
        assert.equal(await request.text(), '{"stream":true}');
        for (const header of ["authorization", "cookie", "x-api-key", nativeAuthenticationHeader])
          assert.equal(request.headers.has(header), false);
        const assertion = request.headers.get(nativeModelHeader);
        assert.ok(assertion);
        const value = (await openEnvelope(signingKey, nativeModelPrefix, assertion)) as Record<
          string,
          unknown
        >;
        assert.equal(value.grant, grant.id);
        assert.equal(value.user, grant.userId);
        assert.equal(value.computer, grant.policy.computer);
        assert.equal(value.pool, grant.policy.pool);
        assert.equal(value.method, "POST");
        assert.equal(value.path, "/v1/responses?stream=true");
        assert.ok(Number(value.expiresAt) > Date.now());
        return new Response("data: completed\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
  };
  const response = await handleRequest(
    new Request("https://app.signalbox.run/v1/responses?stream=true", {
      method: "POST",
      headers: {
        authorization: "Bearer native-opaque-token",
        cookie: "browser=secret",
        [nativeAuthenticationHeader]: "1",
        "x-api-key": "unrelated",
      },
      body: '{"stream":true}',
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "data: completed\n\n");
  assert.equal(checks, 1);
  assert.equal(forwarded, 1);
});

test("native ingress refuses invalid grants and outages without trying model-key authentication", async () => {
  for (const [status, expected, body] of [
    [401, 401, null],
    [503, 503, null],
    [200, 503, {}],
  ] as const) {
    let forwarded = 0;
    const env: RouterEnv = {
      POOL_APP_SIGNING_KEY: signingKey,
      TOOLS_SERVICE: { fetch: async () => Response.json(body, { status }) },
      POOL_SERVICE: {
        fetch: async () => {
          forwarded++;
          return new Response("unexpected");
        },
      },
      CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
    };
    const response = await handleRequest(
      new Request("https://app.signalbox.run/v1/models", {
        headers: { authorization: "Bearer native-opaque-token", [nativeAuthenticationHeader]: "1" },
      }),
      env,
    );
    assert.equal(response.status, expected);
    assert.equal(forwarded, 0);
  }
});

test("ordinary direct model keys keep their existing pool path", async () => {
  let checked = false;
  const env: RouterEnv = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: {
      fetch: async () => {
        checked = true;
        return new Response(null, { status: 401 });
      },
    },
    POOL_SERVICE: {
      fetch: async (request) => {
        assert.equal(request.headers.get("authorization"), "Bearer ordinary-model-key");
        return new Response("models");
      },
    },
    CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
  };
  assert.equal(
    (
      await handleRequest(
        new Request("https://app.signalbox.run/v1/models", {
          headers: { authorization: "Bearer ordinary-model-key" },
        }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(checked, false);
});

test("tools-only native grants cannot enter the model gateway", async () => {
  let forwarded = false;
  const env: RouterEnv = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: {
      fetch: async () => Response.json({ ...grant, policy: { ...grant.policy, models: false } }),
    },
    POOL_SERVICE: {
      fetch: async () => {
        forwarded = true;
        return new Response("unexpected");
      },
    },
    CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
  };
  const response = await handleRequest(
    new Request("https://app.signalbox.run/v1/models", {
      headers: { authorization: "Bearer tools-only-native", [nativeAuthenticationHeader]: "1" },
    }),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(forwarded, false);
});

for (const native of [false, true]) test(`an uncertain ${native ? "native" : "direct"} model binding send is not retryable`, async () => {
  let sends = 0;
  const env: RouterEnv = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: { fetch: async () => Response.json(grant) },
    CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
    POOL_SERVICE: { fetch: async (request) => {
      sends++;
      assert.equal(await request.text(), '{"state":"synthetic-unknown"}');
      throw new Error("synthetic transport loss after accepting request");
    } },
  };
  const response = await handleRequest(new Request("https://app.signalbox.run/v1/responses", {
    method: "POST", headers: { authorization: "Bearer synthetic", ...(native ? { [nativeAuthenticationHeader]: "1" } : {}) },
    body: '{"state":"synthetic-unknown"}',
  }), env);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(response.headers.get("retry-after-ms"), null);
  const body = await response.json() as { error: { code: string; retryable: boolean; message: string } };
  assert.equal(body.error.code, "upstream_outcome_unknown");
  assert.equal(body.error.retryable, false);
  assert.match(body.error.message, /outcome is unknown/u);
  assert.equal(sends, 1);
});

test("a definite Home refusal retains its retryable 503 through model ingress", async () => {
  const env: RouterEnv = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: { fetch: async () => Response.json(grant) },
    CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
    POOL_SERVICE: { fetch: async () => Response.json({ error: "auth_unavailable" }, { status: 503, headers: { "Retry-After": "7" } }) },
  };
  for (const native of [false, true]) {
    const response = await handleRequest(new Request("https://app.signalbox.run/v1/responses", {
      method: "POST", headers: { authorization: "Bearer synthetic", ...(native ? { [nativeAuthenticationHeader]: "1" } : {}) }, body: "{}",
    }), env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(response.headers.get("x-should-retry"), null);
    assert.deepEqual(await response.json(), { error: "auth_unavailable" });
  }
});
