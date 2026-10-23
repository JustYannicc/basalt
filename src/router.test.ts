import assert from "node:assert/strict";
import { test } from "node:test";
import router, { handleRequest, type RouterEnv } from "./router.ts";

function envWithToolsService(fetchRequest: RouterEnv["TOOLS_SERVICE"]["fetch"]): RouterEnv {
  return {
    TOOLS_SERVICE: { fetch: fetchRequest },
    POOL_SERVICE: { fetch: async () => new Response("pool", { status: 202 }) },
  };
}

test("forwards app, MCP, OAuth, and non-boundary paths unchanged", async () => {
  const paths = [
    "/",
    "/settings?tab=keys",
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

test("forwards model and authenticated management paths unchanged to the pool", async () => {
  const paths = ["/v1", "/v1?mode=models", "/v1/", "/v1/models", "/v1/responses", "/v8/management/config", "/v0/management/config"];
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
