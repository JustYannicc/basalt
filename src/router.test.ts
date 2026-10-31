import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../brand.ts";
import router, { handleRequest, notFoundPage, type RouterEnv } from "./router.ts";

function envWithToolsService(fetchRequest: RouterEnv["TOOLS_SERVICE"]["fetch"]): RouterEnv {
  return {
    CATALOG_SERVICE: { fetch: async () => new Response("catalog") },
    TOOLS_SERVICE: { fetch: fetchRequest },
    POOL_SERVICE: { fetch: async () => new Response("pool", { status: 202 }) },
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
  };
}

test("private setup routes never reach a service from the public router", async () => {
  const env = envWithToolsService(async () => { throw new Error("private path forwarded"); });
  for (const path of ["/__setup/v1/claim", "/__setup/v1/links", "/%5f%5fsetup/v1/revoke"])
    assert.equal((await handleRequest(new Request(`https://app.signalbox.run${path}`), env)).status, 404);
});

test("forwards app, MCP, OAuth, and non-boundary paths unchanged", async () => {
  const paths = [
    "/device?user_code=BCDF-GHJK",
    "/settings?tab=keys",
    "/login",
    "/org/team/apps",
    "/.well-known/agent-skills/index.json",
    "/mcp",
    "/mcp/tools/call",
    "/.well-known/oauth-authorization-server",
    "/oauth/authorize?client_id=signalbox",
    "/oauth/callback?state=example",
    "/pool/v10",
    "/pool/v10/pool",
    "/poolx",
    "/pool/v1foo",
    "/poolx/v1/pool",
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

test("native approval serves its own page and keeps device codes out of the asset URL", async () => {
  const assets: Request[] = [];
  const env: RouterEnv = {
    ...envWithToolsService(async () => { throw new Error("native approval reached the generic device page"); }),
    ASSETS: { fetch: async (request) => {
      assets.push(request);
      return new URL(request.url).pathname === "/native-device/index.html"
        ? new Response(request.method === "HEAD" ? null : "<html>Native approval</html>", { headers: { "Content-Type": "text/html" } })
        : new Response(null, { status: 404 });
    } },
  };
  for (const path of ["/native/device", "/native/device/"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await handleRequest(new Request(`https://app.signalbox.run${path}?user_code=BCDF-GHJK`, { method }), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      assert.equal(assets.at(-1)?.url, "https://app.signalbox.run/native-device/index.html");
      assert.equal(assets.at(-1)?.method, method);
      assert.equal(await response.text(), method === "HEAD" ? "" : "<html>Native approval</html>");
    }
  }
  const before = assets.length;
  const response = await handleRequest(new Request("https://app.signalbox.run/native/device", { method: "POST" }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(assets.length, before);
  assert.equal((await handleRequest(new Request("https://app.signalbox.run/native/device"), {
    ...env, ASSETS: undefined,
  })).status, 404);
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

test("forwards model and pool control paths unchanged to the pool", async () => {
  const paths = ["/pool/v1", "/pool/v1/", "/pool/v1/pool", "/pool/v1/sign-ins?session=example", "/v1", "/v1?mode=models", "/v1/", "/v1/models", "/v1/responses", "/messages", "/chat/completions", "/completions"];
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
      }), { CATALOG_SERVICE: service, TOOLS_SERVICE: service, POOL_SERVICE: service, POOL_APP_SIGNING_KEY: "ab".repeat(32) });
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
    "__Host-executor-hosted.session_token=abc",
    "theme=dark; __Host-executor-hosted.session_token=abc",
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
  // The brand's own legal pages are on its site; the tools service's never answer.
  for (const [path, page] of [
    ["/privacy", brand.links.privacy],
    ["/privacy/", brand.links.privacy],
    ["/terms", brand.links.terms],
  ] as const) {
    const response = await handleRequest(new Request(`https://app.signalbox.run${path}`), env);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), page, path);
  }
  assert.equal(toolsCalls, 0);
});

test("sends a homepage visit to sign-in without the tools service's own session cookie", async () => {
  for (const cookie of [
    "__Host-executor-hosted.session_token=",
    "executor-hosted.session_token=abc",
    "__Secure-executor-hosted.session_token=abc",
    "__Secure-__Host-executor-hosted.session_token=abc",
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


test("the catalog uses its own binding without forwarding to the tools API", async () => {
  let received: Request | undefined;
  const request = new Request("https://app.signalbox.run/catalog/index.json");
  const env = envWithToolsService(async () => { throw new Error("catalog reached tools"); });
  env.CATALOG_SERVICE = { fetch: async value => { received = value; return new Response("catalog"); } };
  assert.equal(await (await handleRequest(request, env)).text(), "catalog");
  assert.equal(received, request);
});

test("opaque app hosts reach app UI before path handlers or dashboard static assets", async () => {
  const appHost = "a-01234567-89ab-4cde-8fab-0123456789ab.signalbox.run";
  const seen: string[] = [];
  const env: RouterEnv = {
    ...envWithToolsService(async () => { throw new Error("dashboard service reached from app origin"); }),
    ASSETS: { fetch: async () => { throw new Error("dashboard assets reached from app origin"); } },
    APP_UI_SERVICE: { fetch: async (request) => { seen.push(request.url); return new Response("private app UI"); } },
  };
  for (const path of ["/", "/setup", "/mcp", "/pool/v1/status", "/catalog/index.json", "/ui.css"]) {
    const request = new Request(`https://${appHost}${path}`);
    const response = await handleRequest(request, env);
    assert.equal(await response.text(), "private app UI");
    assert.equal(seen.at(-1), request.url);
  }
});

test("unknown app subdomains return empty 404s without reaching any service", async () => {
  const refuse = async () => { throw new Error("unknown host reached a service"); };
  const env: RouterEnv = { ...envWithToolsService(refuse), ASSETS: { fetch: refuse }, APP_UI_SERVICE: { fetch: refuse } };
  for (const host of ["unknown.signalbox.run", "a-name.signalbox.run", "a-01234567-89ab-4cde-8fab-0123456789ab.nested.signalbox.run", "a-01234567-89ab-4cde-8fab-0123456789ab.other.run"]) {
    const response = await handleRequest(new Request(`https://${host}/`), env);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  }
});

test("product hosts keep dashboard, pool and static asset routing", async () => {
  const env: RouterEnv = {
    ...envWithToolsService(async () => new Response("dashboard")),
    ASSETS: { fetch: async (request) => new URL(request.url).pathname === "/brand/logo.png" ? new Response("brand asset") : new Response(null, { status: 404 }) },
    APP_UI_SERVICE: { fetch: async () => { throw new Error("product request reached app UI"); } },
  };
  assert.equal(await (await handleRequest(new Request("https://app.signalbox.run/settings"), env)).text(), "dashboard");
  assert.equal(await (await handleRequest(new Request("https://app.signalbox.run/brand/logo.png"), env)).text(), "brand asset");
  // The old setup page redirects; signed out, to sign-in.
  for (const path of ["/setup", "/setup/", "/SETUP"]) {
    const moved = await handleRequest(new Request(`https://app.signalbox.run${path}`), env);
    assert.equal(moved.status, 302, path);
    assert.equal(moved.headers.get("location"), "/login?redirect=%2Fsetup", path);
  }
  assert.equal((await handleRequest(new Request("https://app.signalbox.run/v1/models"), env)).status, 202);
  const stage = { ...env, DASHBOARD_HOST: "app.fixture.invalid" };
  assert.equal(await (await handleRequest(new Request("https://app.fixture.invalid/settings"), stage)).text(), "dashboard");
});

test("router HTML refuses framing, including static setup/share pages and branded failures", async () => {
  const html = () => new Response("<html>private dashboard</html>", {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; frame-ancestors *" },
  });
  const env: RouterEnv = { ...envWithToolsService(async () => html()), ASSETS: { fetch: async (request) =>
    ["/setup", "/share", "/index.html", "/app-auth"].includes(new URL(request.url).pathname) ? html() : new Response(null, { status: 404 }) } };
  for (const path of ["/setup", "/share", "/index.html", "/app-auth", "/settings", "/home"]) {
    const response = await handleRequest(new Request(`https://app.signalbox.run${path}`), env);
    assert.match(response.headers.get("content-security-policy") ?? "", /(?:^|;)\s*frame-ancestors 'none'(?:;|$)/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    if (path !== "/home") assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  }
  const auth = await handleRequest(new Request("https://app.signalbox.run/app-auth"), envWithToolsService(async () => new Response("auth", { headers: {
    "content-type": "text/html", "content-security-policy": "frame-ancestors 'self'", "x-frame-options": "SAMEORIGIN",
  } })));
  assert.equal(auth.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(auth.headers.get("x-frame-options"), "SAMEORIGIN");
  const appEnv = { ...env, APP_UI_SERVICE: { fetch: async () => new Response("app", { headers: { "content-type": "text/html", "content-security-policy": "frame-ancestors https://app.signalbox.run" } }) } };
  const app = await handleRequest(new Request("https://a-01234567-89ab-4cde-8fab-0123456789ab.signalbox.run/"), appEnv);
  assert.equal(app.headers.get("content-security-policy"), "frame-ancestors https://app.signalbox.run");
});
