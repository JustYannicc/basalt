import assert from "node:assert/strict";
import { test } from "node:test";
import { handleFeedback } from "./host.ts";
const dsn = "https://synthetic@o0.ingest.de.sentry.io/1";
function request(payload: unknown, path = "submit", headers = {}) {
  return new Request(`https://example.invalid/feedback/v1/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.invalid", Cookie: "session=synthetic", ...headers }, body: JSON.stringify(payload) });
}
function environment() {
  return { SENTRY_DSN: dsn, TOOLS_SERVICE: { fetch: async (request: Request) => {
    assert.equal(new URL(request.url).pathname, "/api/auth/get-session");
    assert.equal(request.headers.has("authorization"), false);
    return Response.json({ user: { id: "account_fixture", email: "not-exported@example.invalid", name: "Not exported" } });
  } } };
}
function recordEnvelope(t: import("node:test").TestContext) {
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(await new Response(init.body).text());
    return new Response(null, { status: 200 });
  });
  return bodies;
}
test("web feedback exports only verified account, explicit text and safe route/error metadata", async (t) => {
  const bodies = recordEnvelope(t);
  const response = await handleFeedback(request({ message: "The page failed.", page: "/setup/claim/private-token?hidden=content", errors: [{ code: "script_error" }, { code: "message@example.invalid" }] }), environment());
  assert.equal(response.status, 204);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /account_fixture/);
  assert.match(bodies[0]!, /The page failed/);
  assert.match(bodies[0]!, /\/setup\/claim\/:token/);
  assert.match(bodies[0]!, /script_error/);
  assert.doesNotMatch(bodies[0]!, /private-token|hidden|example.invalid|Not exported|email/);
});
test("feedback requires same-origin authenticated session and refuses caller identity", async (t) => {
  const bodies = recordEnvelope(t);
  assert.equal((await handleFeedback(request({ message: "text", account_id: "spoofed" }), environment())).status, 400);
  assert.equal((await handleFeedback(request({ message: "text" }, "submit", { Origin: "https://other.invalid" }), environment())).status, 403);
  assert.equal((await handleFeedback(request({ message: "text" }, "submit", { Authorization: "Bearer synthetic" }), environment())).status, 403);
  assert.equal((await handleFeedback(request({ message: "text" }, "submit", { Cookie: "" }), environment())).status, 401);
  assert.equal(bodies.length, 0);
});
test("optional screenshot is signature-checked and caller filename is discarded", async (t) => {
  const bodies = recordEnvelope(t);
  const png = btoa(String.fromCharCode(137,80,78,71,13,10,26,10));
  const response = await handleFeedback(request({ message: "text", screenshot: { name: "private-filename.png", type: "image/png", data: png } }), environment());
  assert.equal(response.status, 204);
  assert.match(bodies[0]!, /screenshot.png/);
  assert.doesNotMatch(bodies[0]!, /private-filename/);
  assert.equal((await handleFeedback(request({ message: "text", screenshot: { name: "a.png", type: "image/png", data: btoa("not an image") } }), environment())).status, 400);
});
test("error reporting accepts only the fixed browser vocabulary", async (t) => {
  const bodies = recordEnvelope(t);
  assert.equal((await handleFeedback(request({ code: "http_5xx", page: "/apps/private" }, "error"), environment())).status, 204);
  assert.match(bodies[0]!, /http_5xx/);
  assert.doesNotMatch(bodies[0]!, /private/);
  assert.equal((await handleFeedback(request({ code: "raw error text", page: "/" }, "error"), environment())).status, 400);
});
test("status exposes availability only and disabled submission never reports success", async () => {
  for (const [SENTRY_DSN, enabled] of [[undefined,false],["",false],[dsn,true]] as const) {
    const env = { ...environment(), SENTRY_DSN };
    const result = await handleFeedback(new Request("https://example.invalid/feedback/v1/status"), env);
    assert.deepEqual(await result.json(), { enabled });
    if (!enabled) assert.equal((await handleFeedback(request({ message: "text" }), env)).status, 503);
  }
});
