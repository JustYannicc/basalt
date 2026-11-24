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

for (const native of [false, true])
  test(`an uncertain ${native ? "native" : "direct"} model binding send lost twice asks the client to retry`, async () => {
    let sends = 0;
    const env: RouterEnv = {
      POOL_APP_SIGNING_KEY: signingKey,
      TOOLS_SERVICE: { fetch: async () => Response.json(grant) },
      CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
      POOL_SERVICE: {
        fetch: async (request) => {
          sends++;
          assert.equal(await request.text(), '{"state":"synthetic-unknown"}');
          throw new Error("synthetic transport loss after accepting request");
        },
      },
    };
    const response = await handleRequest(
      new Request("https://app.signalbox.run/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic",
          ...(native ? { [nativeAuthenticationHeader]: "1" } : {}),
        },
        body: '{"state":"synthetic-unknown"}',
      }),
      env,
    );
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-should-retry"), null);
    assert.equal(response.headers.get("retry-after"), "1");
    const body = (await response.json()) as {
      error: { code: string; retryable: boolean; message: string };
    };
    assert.equal(body.error.code, "upstream_outcome_unknown");
    assert.equal(body.error.retryable, true);
    assert.match(body.error.message, /Retry it/u);
    assert.equal(sends, 2);
  });

test("a definite Home refusal retains its retryable 503 through model ingress", async () => {
  const env: RouterEnv = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: { fetch: async () => Response.json(grant) },
    CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
    POOL_SERVICE: {
      fetch: async () =>
        Response.json(
          { error: "auth_unavailable" },
          { status: 503, headers: { "Retry-After": "7" } },
        ),
    },
  };
  for (const native of [false, true]) {
    const response = await handleRequest(
      new Request("https://app.signalbox.run/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic",
          ...(native ? { [nativeAuthenticationHeader]: "1" } : {}),
        },
        body: "{}",
      }),
      env,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(response.headers.get("x-should-retry"), null);
    assert.deepEqual(await response.json(), { error: "auth_unavailable" });
  }
});

// 24 Nov 03:14Z: the platform replaced the pool controller's isolate and every hop inside the pool
// Worker was cancelled with it, the entry that holds and replays included. Only the router outlived
// it, and its binding send rejected. The controller was back 1.4 s later.
for (const native of [false, true])
  test(`a ${native ? "native" : "direct"} model call whose pool send is cancelled before its answer is sent again and served`, async () => {
    const bodies: string[] = [];
    const assertions: (string | null)[] = [];
    const env: RouterEnv = {
      POOL_APP_SIGNING_KEY: signingKey,
      TOOLS_SERVICE: { fetch: async () => Response.json(grant) },
      CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
      POOL_SERVICE: {
        fetch: async (request) => {
          bodies.push(await request.text());
          assertions.push(request.headers.get(nativeModelHeader));
          if (bodies.length === 1) throw new Error("The script will never generate a response.");
          return Response.json({ id: "msg_synthetic" });
        },
      },
    };
    const response = await handleRequest(
      new Request("https://app.signalbox.run/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic",
          ...(native ? { [nativeAuthenticationHeader]: "1" } : {}),
        },
        body: '{"model":"synthetic","messages":[]}',
      }),
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { id: "msg_synthetic" });
    assert.deepEqual(bodies, Array(2).fill('{"model":"synthetic","messages":[]}'));
    if (native) {
      const second = (await openEnvelope(signingKey, nativeModelPrefix, assertions[1]!)) as {
        expiresAt: number;
      };
      assert.ok(second.expiresAt > Date.now());
    }
  });

// 24 Nov: through the built Router, a socket the pool refused with 401 reached its client as 503,
// because the router could not sign its name for the call. A refusal is the pool's answer, on every
// path, whether or not the router can name the call.
for (const key of [signingKey, ""])
  for (const native of [false, true])
    for (const socket of [false, true])
      test(`the pool's 401 reaches a ${native ? "native" : "direct"} ${socket ? "socket" : "call"} ${key ? "the router names" : "the router cannot name"}`, async () => {
        if (native && !key) return; // A device call needs the key for its own assertion.
        let reached = 0;
        const env: RouterEnv = {
          POOL_APP_SIGNING_KEY: key,
          TOOLS_SERVICE: { fetch: async () => Response.json(grant) },
          CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) },
          POOL_SERVICE: {
            fetch: async () => {
              reached++;
              return Response.json({ error: "Invalid API key" }, { status: 401 });
            },
          },
        };
        const response = await handleRequest(
          new Request("https://app.signalbox.run/v1/responses", {
            method: socket ? "GET" : "POST",
            headers: {
              authorization: "Bearer synthetic",
              ...(socket ? { Upgrade: "websocket" } : {}),
              ...(native ? { [nativeAuthenticationHeader]: "1" } : {}),
            },
            ...(socket ? {} : { body: "{}" }),
          }),
          env,
        );
        assert.equal(response.status, 401);
        assert.equal(reached, 1);
      });
