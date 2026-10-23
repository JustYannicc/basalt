import assert from "node:assert/strict";
import { test } from "node:test";
import router, { handleRequest, notFoundPage, type RouterEnv } from "./router.ts";

function envWithToolsService(fetchRequest: RouterEnv["TOOLS_SERVICE"]["fetch"]): RouterEnv {
  return {
    TOOLS_SERVICE: { fetch: fetchRequest },
    POOL_SERVICE: { fetch: async () => new Response("pool", { status: 202 }) },
  };
}

test("forwards app, MCP, OAuth, and non-boundary paths unchanged", async () => {
  const paths = [
    "/settings?tab=keys",
    "/login",
    "/org/team/apps",
    "/.well-known/agent-skills/index.json",
    "/mcp",
    "/mcp/tools/call",
    "/.well-known/oauth-authorization-server",
    "/oauth/authorize?client_id=signalbox",
    "/oauth/callback?state=example",
    "/v10",
    "/v10/models",
    "/v1foo",
    "/v1foo/models",
    "/v8/management-other",
    "/v0/management-other",
  ];

  for (const path of paths) {
    const request = new Request(`https://app.signalbox.run${path}`);
    let forwarded: Request | undefined;
    const toolsResponse = new Response(`tools: ${path}`, { status: 202 });

    const response = await router.fetch(
      request,
      envWithToolsService(async (serviceRequest) => {
        forwarded = serviceRequest;
        return toolsResponse;
      }),
    );

    assert.strictEqual(forwarded, request, `${path} should keep the original request`);
    assert.strictEqual(response, toolsResponse, `${path} should keep the upstream response`);
  }
});

test("preserves a POST body and headers and returns the streamed tools response", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const requestBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"part":'));
      controller.enqueue(encoder.encode('"body"}'));
      controller.close();
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      Authorization: "Bearer example",
      "Content-Type": "application/json",
      "X-Correlation-Id": "corr-1",
    },
    body: requestBody,
    duplex: "half",
  };
  const request = new Request(
    "https://app.signalbox.run/oauth/callback?code=example&state=state",
    init,
  );
  let forwarded: Request | undefined;
  let forwardedBody = "";
  const toolsResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first "));
        controller.enqueue(encoder.encode("second"));
        controller.close();
      },
    }),
    { status: 201, headers: { "X-Upstream": "tools" } },
  );

  const response = await handleRequest(
    request,
    envWithToolsService(async (serviceRequest) => {
      forwarded = serviceRequest;
      assert.equal(serviceRequest.url, request.url);
      assert.equal(serviceRequest.method, "POST");
      assert.equal(serviceRequest.headers.get("authorization"), "Bearer example");
      assert.equal(serviceRequest.headers.get("x-correlation-id"), "corr-1");

      const reader = serviceRequest.body?.getReader();
      assert.ok(reader);
      const bodyChunks: Uint8Array[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bodyChunks.push(chunk.value);
      }
      forwardedBody = bodyChunks.map((chunk) => decoder.decode(chunk)).join("");
      return toolsResponse;
    }),
  );

  assert.strictEqual(forwarded, request);
  assert.equal(forwardedBody, '{"part":"body"}');
  assert.strictEqual(response, toolsResponse);
  assert.strictEqual(response.body, toolsResponse.body);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream"), "tools");
  assert.equal(await response.text(), "first second");
});

test("forwards model paths unchanged to the pool", async () => {
  const paths = ["/v1", "/v1?mode=models", "/v1/", "/v1/models", "/v1/responses"];
  const env = envWithToolsService(async () => { throw new Error("unexpected tools request"); });
  for (const path of paths) {
    const request = new Request(`https://app.signalbox.run${path}`);
    const upstream = new Response("data: response\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    env.POOL_SERVICE.fetch = async (forwarded) => {
      assert.strictEqual(forwarded, request);
      return upstream;
    };
    assert.strictEqual(await handleRequest(request, env), upstream);
  }
});

test("public management requests never reach either service binding", async () => {
  let forwarded = 0;
  const service = { fetch: async () => { forwarded += 1; return new Response("upstream"); } };
  const paths = [
    "/v0/management", "/v0/management/", "/v0/management/config",
    "/v8/management", "/v8/management/oauth/callback?state=example",
    "/v8/management/credentials", "/V8/MANAGEMENT/config",
    "//v8/management/config", "/%76%38/management/config",
  ];
  for (const path of paths) {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await handleRequest(new Request(`https://app.signalbox.run${path}`, {
        method, headers: { "X-Management-Key": "example" },
      }), { TOOLS_SERVICE: service, POOL_SERVICE: service });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }
  assert.equal(forwarded, 0);
});

test("sends signed-out visitors from the homepage to sign-in, keeping the query", async () => {
  const env = envWithToolsService(async () => new Response("marketing"));
  const response = await handleRequest(new Request("https://app.signalbox.run/?ref=mail"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/login?ref=mail");
  for (const path of ["/;", "//", "///", "/;x=1"]) {
    const variant = await handleRequest(new Request(`https://app.signalbox.run${path}`), env);
    assert.equal(variant.status, 302, path);
  }
});

test("forwards the homepage of a signed-in browser to the tools service", async () => {
  for (const cookie of [
    "__Secure-executor-hosted.session_token=abc",
    "theme=dark; executor-hosted.session_token=abc",
  ]) {
    const request = new Request("https://app.signalbox.run/", { headers: { cookie } });
    const dashboard = new Response("dashboard");
    const response = await handleRequest(
      request,
      envWithToolsService(async () => dashboard),
    );
    assert.strictEqual(response, dashboard, cookie);
  }
});

test("never forwards the tools service's marketing, docs or legal pages", async () => {
  let toolsCalls = 0;
  const env = envWithToolsService(async () => {
    toolsCalls += 1;
    return new Response("tools service site");
  });
  for (const path of [
    "/home",
    "/pricing",
    "/llms.txt",
    "/docs",
    "/docs/",
    "/docs/api-keys/",
    "/blog",
    "/blog/launch",
    "/apps",
    "/apps/github",
    "/about-executor",
    "/privacy",
    "/privacy/",
    "/terms",
    "/index.html",
    "/404.html",
    "/pricing/index.html",
    "/_astro/site.js",
    "/og-image.png",
    "//pricing",
    "/PRICING",
    "/%70ricing",
    "/pricing;x",
  ]) {
    const response = await handleRequest(new Request(`https://app.signalbox.run${path}`), env);
    assert.equal(response.status, 404, path);
  }
  assert.equal(toolsCalls, 0);
});

test("sends a homepage visit to sign-in without the tools service's own session cookie", async () => {
  for (const cookie of [
    "executor-hosted.session_token=",
    "better-auth.session_token=abc",
    "other-app.session_token=abc",
  ]) {
    const request = new Request("https://app.signalbox.run/", { headers: { cookie } });
    const response = await handleRequest(request, envWithToolsService(async () => new Response()));
    assert.equal(response.status, 302, cookie);
  }
});

test("replaces the tools service's marketing 404 page and keeps the dashboard's", async () => {
  const marketing = await handleRequest(
    new Request("https://app.signalbox.run/typo"),
    envWithToolsService(
      async () =>
        new Response("<title>Page not found</title>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
    ),
  );
  assert.equal(marketing.status, 404);
  assert.equal(await marketing.text(), await notFoundPage().text());
  const dashboard = await handleRequest(
    new Request("https://app.signalbox.run/org/team/missing"),
    envWithToolsService(
      async () =>
        new Response('<html data-dashboard="">missing</html>', {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
    ),
  );
  assert.equal(await dashboard.text(), '<html data-dashboard="">missing</html>');
  const api = new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  const passed = await handleRequest(
    new Request("https://app.signalbox.run/api/missing"),
    envWithToolsService(async () => api),
  );
  assert.strictEqual(passed, api);
});
