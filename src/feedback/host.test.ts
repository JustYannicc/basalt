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
test("web feedback exports only verified account, explicit text and a safe route", async (t) => {
  const bodies = recordEnvelope(t);
  const response = await handleFeedback(request({ message: "The page failed.", page: "/setup/claim/private-token?hidden=content" }), environment());
  assert.equal(response.status, 204);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /account_fixture/);
  assert.match(bodies[0]!, /The page failed/);
  assert.match(bodies[0]!, /\/setup\/claim\/:token/);
  assert.doesNotMatch(bodies[0]!, /private-token|hidden|Not exported|email/);
  // The old widget's error codes are no longer accepted.
  assert.equal((await handleFeedback(request({ message: "text", errors: [{ code: "script_error" }] }), environment())).status, 400);
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
test("only submission remains: the old widget's status and error routes are gone", async () => {
  for (const path of ["/feedback/v1/status", "/feedback/v1/error"])
    assert.equal((await handleFeedback(new Request(`https://example.invalid${path}`), environment())).status, 404);
});
const at = "2026-10-30T12:00:00.000Z";
test("optional logs are capped, redacted again and attached as one JSON file", async (t) => {
  const bodies = recordEnvelope(t);
  const logs = [
    { kind: "error", at, message: "TypeError: x at https://app.example.invalid/a?token=raw-query Authorization: Bearer abcdefghijklmnop sk-live-1234567890abcdef person@example.invalid" },
    { kind: "request", at, method: "GET", path: "/api/accounts?cursor=raw-cursor", status: 500, durationMs: 42 },
  ];
  assert.equal((await handleFeedback(request({ message: "text", page: "/", logs }), environment())).status, 204);
  assert.match(bodies[0]!, /"filename":"logs.json","content_type":"application\/json"/);
  assert.match(bodies[0]!, /TypeError: x at https:\/\/app.example.invalid\/a/);
  assert.match(bodies[0]!, /"path":"\/api\/accounts","status":500,"durationMs":42/);
  assert.doesNotMatch(bodies[0]!, /raw-query|raw-cursor|abcdefghijklmnop|sk-live|person@/);
  assert.equal((await handleFeedback(request({ message: "text", page: "/", logs: [] }), environment())).status, 204);
  assert.doesNotMatch(bodies[1]!, /logs.json/);
});
test("redaction covers headers logged as JSON, odd paths, encoded addresses and named secrets", async (t) => {
  const bodies = recordEnvelope(t);
  const logs = [
    { kind: "error", at, message: JSON.stringify({ headers: { cookie: "theme=dark; sid=raw-session", authorization: "Token raw-auth" } }) },
    { kind: "error", at, message: "Request failed /api/apps/foo:bar?token=raw-colon-query" },
    { kind: "error", at, message: "lookup /api/users/person%40example.invalid failed; password=raw-password" },
    { kind: "request", at, method: "GET", path: "/assets/font.woff2", crossOrigin: true, status: 404, durationMs: 3 },
  ];
  assert.equal((await handleFeedback(request({ message: "text", page: "/org/acme/apps", logs }), environment())).status, 204);
  assert.doesNotMatch(bodies[0]!, /raw-session|raw-auth|raw-colon-query|person%40|raw-password|acme/);
  assert.match(bodies[0]!, /"crossOrigin":true/);
  assert.match(bodies[0]!, /\/org\/:slug\/apps/);
});
test("malformed log entries are left out, and logs outside their caps are refused", async (t) => {
  const bodies = recordEnvelope(t);
  const error = { kind: "error", at, message: "x" };
  assert.equal((await handleFeedback(request({ message: "text", logs: {} }), environment())).status, 400);
  for (const logs of [
    [{ ...error, stack: "extra" }], [{ ...error, kind: "warning" }], [{ ...error, at: "yesterday" }],
    [{ kind: "request", at, method: "get", path: "/", status: 500, durationMs: 1 }],
    [{ kind: "request", at, method: "GET", path: "https://other.invalid/", status: 500, durationMs: 1 }],
    [{ kind: "request", at, method: "GET", path: "/", crossOrigin: false, status: 500, durationMs: 1 }],
    [{ kind: "request", at, method: "GET", path: "/", status: 700, durationMs: 1 }],
    [{ ...error, message: "x".repeat(1025) }],
  ]) {
    assert.equal((await handleFeedback(request({ message: "text", logs }), environment())).status, 204, JSON.stringify(logs).slice(0, 80));
    assert.doesNotMatch(bodies.at(-1)!, /logs.json/);
  }
  bodies.length = 0;
  assert.equal((await handleFeedback(request({ message: "text", logs: Array(51).fill(error) }), environment())).status, 413);
  assert.equal((await handleFeedback(request({ message: "text", logs: Array(20).fill({ ...error, message: "x".repeat(1000) }) }), environment())).status, 413);
  assert.equal(bodies.length, 0);
});
