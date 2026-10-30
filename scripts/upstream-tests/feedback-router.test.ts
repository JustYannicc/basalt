import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { build } = require("esbuild") as typeof import("esbuild");
const { Miniflare } = require("miniflare") as typeof import("miniflare");

test("bundled router leaves pages alone and routes web and agent feedback through one safe destination", async () => {
  const bundle = await build({
    stdin: {
      contents: 'import router from "./src/router.ts"; export default router;',
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts",
    },
    bundle: true, write: false, platform: "browser", format: "esm", target: "es2022",
  });
  const delivered: { url: string; body: string }[] = [];
  let vendorStatus = 200;
  const key = "a".repeat(64);
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0]!.text,
    // The pinned Miniflare binary supports this date. Live deployment uses the stack's date.
    compatibilityDate: "2026-08-06",
    bindings: {
      DASHBOARD_HOST: "example.invalid",
      POOL_APP_SIGNING_KEY: "b".repeat(64), TELEMETRY_RELAY_KEY: key,
      SENTRY_DSN: "https://synthetic@o0.ingest.de.sentry.io/1", POSTHOG_PROJECT_KEY: "synthetic_project_key",
    },
    serviceBindings: {
      TOOLS_SERVICE: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/get-session") return Response.json({ user: { id: "account_fixture", email: "not-exported@example.invalid" } });
        return new Response('<!doctype html><html><body data-dashboard><main>Fixture</main></body></html>', { headers: { "Content-Type": "text/html" } });
      },
      POOL_SERVICE: async () => new Response("unused"),
    },
    outboundService: async (request: Request) => {
      delivered.push({ url: request.url, body: await request.text() });
      return new Response(null, { status: vendorStatus, headers: vendorStatus === 302 ? { Location: "https://other.invalid/" } : {} });
    },
  });
  try {
    for (const path of ["/login", "/org/fixture/apps", "/pricing"]) {
      const response = await mf.dispatchFetch(`https://example.invalid${path}`);
      // The dashboard's own sidebar carries the feedback form; the router adds no script.
      assert.doesNotMatch(await response.text(), /<script/, path);
    }
    const web = await mf.dispatchFetch("https://example.invalid/feedback/v1/submit", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.invalid", Cookie: "session=synthetic" },
      body: JSON.stringify({
        message: "Web fixture feedback", page: "/setup/claim/private?hidden=content",
        logs: [{ kind: "request", at: "2026-10-30T12:00:00.000Z", method: "GET", path: "/api/fixture?hidden=content", status: 502, durationMs: 9 }],
      }),
    });
    assert.equal(web.status, 204, JSON.stringify({ delivered: delivered.map((entry) => ({ url: entry.url, bytes: entry.body.length })) }));
    const agent = await mf.dispatchFetch("https://example.invalid/__telemetry/v1/feedback", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ account_id: "account_fixture", message: "Agent fixture feedback" }),
    });
    assert.equal(agent.status, 204);
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every((entry) => entry.url === "https://o0.ingest.de.sentry.io/api/1/envelope/"));
    assert.ok(delivered.every((entry) => entry.body.includes('"type":"feedback"')));
    assert.match(delivered[0]!.body, /Web fixture feedback/);
    assert.match(delivered[0]!.body, /"filename":"logs.json"[^\n]*\n\[\{"kind":"request"[^\n]*"path":"\/api\/fixture","status":502/);
    assert.match(delivered[1]!.body, /Agent fixture feedback/);
    assert.doesNotMatch(JSON.stringify(delivered), /not-exported|private\?|hidden=|email/);
    const analytics = await mf.dispatchFetch("https://example.invalid/__telemetry/v1/analytics", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ events: [{ event: "tool_search_empty", account_id: "account_fixture", timestamp: "2026-01-01T00:00:00.000Z", properties: { service_id: "calendar" } }] }),
    });
    assert.equal(analytics.status, 204);
    assert.equal(delivered.length, 3);
    assert.equal(delivered[2]!.url, "https://eu.i.posthog.com/batch/");
    assert.deepEqual(JSON.parse(delivered[2]!.body).batch.map((event: { event: string }) => event.event), ["tool_search_empty", "service_requested"]);
    vendorStatus = 302;
    const rejected = await mf.dispatchFetch("https://example.invalid/__telemetry/v1/feedback", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ account_id: "account_fixture", message: "Redirect fixture feedback" }),
    });
    assert.equal(rejected.status, 503);
    assert.equal(delivered.length, 4, "vendor redirects are rejected without following them");
    assert.ok(delivered.every((entry) => !entry.url.startsWith("https://other.invalid/")));
  } finally { await mf.dispose(); }
});
