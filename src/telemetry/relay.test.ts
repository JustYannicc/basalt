import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRelay } from "./relay.ts";
const key = "a".repeat(64);
const env = { TELEMETRY_RELAY_KEY: key, POSTHOG_PROJECT_KEY: "synthetic_project_key", SENTRY_DSN: "https://synthetic@o0.ingest.de.sentry.io/1" };
function request(payload: unknown, path = "analytics", authorization = `Bearer ${key}`) {
  return new Request(`https://example.invalid/__telemetry/v1/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify(payload) });
}
function event(name: string, properties = {}) { return { event: name, account_id: "account_fixture", timestamp: "2026-01-01T00:00:00.000Z", properties }; }
test("authenticated relay translates signup, catalog misses, installs, calls and invites into one safe batch", async (t) => {
  const calls: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(init.body as string) }); return new Response(null, { status: 200 }); });
  const response = await handleRelay(request({ events: [
    event("cloud_signup_completed"), event("app_installed", { app_id: "calendar" }), event("account_connected"),
    event("tool_execution_completed", { app_id: "calendar" }), event("tool_search_empty", { service_id: "calendar" }),
    event("tool_search_empty"), event("invitation_sent"), event("invitation_accepted"), event("account_connection_failed"),
  ] }), env);
  assert.equal(response.status, 204);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://eu.i.posthog.com/batch/");
  const batch = (calls[0]!.body as { batch: { event: string; properties: unknown }[] }).batch;
  assert.deepEqual(batch.map((entry) => entry.event), ["sign_up", "connector_installed", "account_connected", "tool_called", "tool_search_empty", "service_requested", "tool_search_empty", "invite_sent", "invite_accepted", "connector_connect_failed"]);
  assert.ok(batch.every((entry) => !JSON.stringify(entry).includes("query")));
});
test("relay validates the full batch before sending and rejects email, content and visitor identities", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null); });
  for (const invalid of [
    { ...event("cloud_signup_completed"), account_id: "fixture@example.invalid" },
    event("tool_search_empty", { query: "private" }), event("tool_execution_completed", { app_id: "fixture@example.invalid" }),
    event("$identify"), { ...event("cloud_signup_completed"), email: "fixture@example.invalid" },
    event("app_installed", { app_id: "calendar", content: "private" }),
  ]) assert.equal((await handleRelay(request({ events: [event("cloud_signup_completed"), invalid] }), env)).status, 400);
  assert.equal((await handleRelay(request({ events: [] }, "analytics", "Bearer wrong"), env)).status, 404);
  assert.equal((await handleRelay(request({ events: [] }), { ...env, TELEMETRY_RELAY_KEY: undefined })).status, 404);
  assert.equal(calls, 0);
});
test("unattributed tool calls are dropped without losing other events in the batch", async (t) => {
  const batches: { event: string; properties: Record<string, unknown> }[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    batches.push(JSON.parse(init.body as string).batch);
    return new Response(null);
  });
  assert.equal((await handleRelay(request({ events: [
    event("tool_execution_completed"), event("cloud_signup_completed"), event("tool_execution_completed", { app_id: "calendar" }),
  ] }), env)).status, 204);
  assert.deepEqual(batches[0]!.map(({ event }) => event), ["sign_up", "tool_called"]);
  assert.equal(batches[0]![1]!.properties.app_id, "calendar");
  assert.equal((await handleRelay(request({ events: [event("tool_execution_completed")] }), env)).status, 204);
  assert.equal(batches.length, 1);
});
test("agent feedback reaches the feedback envelope and never PostHog", async (t) => {
  const calls: Request[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => { calls.push(new Request(url, init)); return new Response(null); });
  assert.equal((await handleRelay(request({ account_id: "account_fixture", message: "The tool failed." }, "feedback"), env)).status, 204);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.url).hostname, "o0.ingest.de.sentry.io");
  const body = await calls[0]!.text();
  assert.match(body, /"type":"feedback"/);
  assert.match(body, /The tool failed/);
  assert.doesNotMatch(body, /organization_id|email|api_key/);
  assert.equal((await handleRelay(request({ account_id: "account_fixture", message: "a".repeat(4001) }, "feedback"), env)).status, 413);
});
test("relay reports vendor rejection, while unconfigured analytics are dropped", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  assert.equal((await handleRelay(request({ events: [event("cloud_signup_completed")] }), env)).status, 503);
  assert.equal((await handleRelay(request({ events: [event("cloud_signup_completed")] }), { ...env, POSTHOG_PROJECT_KEY: undefined })).status, 204);
});
