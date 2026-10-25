import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProduct, captureProducts, productEvents, productPayload } from "./product.ts";
import { pageTemplate, recentErrors } from "./privacy.ts";
const forbidden = /email|name|content|query|prompt|message|credential|token|secret|input|output|body|url|header/i;
function assertPrivate(value: unknown): void {
  if (typeof value === "string") assert.doesNotMatch(value, /[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, forbidden);
    assertPrivate(entry);
  }
}
test("every product event has an account-only identity and a closed privacy-safe payload", () => {
  for (const event of productEvents) {
    const properties = event === "service_requested" ? { service_id: "calendar" } : event === "tool_called" ? { app_id: "calendar" } : {};
    const payload = productPayload(event, "account_fixture", properties);
    assertPrivate(payload);
    assert.equal(payload.distinct_id, "account_fixture");
    assert.equal(payload.properties.$process_person_profile, false);
    assert.equal(payload.properties.ip, null);
  }
});
test("tool calls require a resolved app identifier", () => {
  assert.throws(() => productPayload("tool_called", "account_fixture"));
  assert.equal(productPayload("tool_called", "account_fixture", { app_id: "calendar" }).properties.app_id, "calendar");
});
test("all events refuse content fields, nested payloads and email-shaped values", () => {
  for (const event of productEvents) {
    for (const field of ["email", "content", "query", "prompt", "message", "credentials", "name", "input", "output", "body", "url", "headers", "account_id"])
      assert.throws(() => productPayload(event, "account_fixture", JSON.parse(`{"${field}":"private"}`)));
    assert.throws(() => productPayload(event, "fixture@example.invalid"));
    assert.throws(() => productPayload(event, "account_fixture", { app_id: "fixture@example.invalid" }));
  }
  assert.throws(() => productPayload("service_requested", "account_fixture", { service_id: "a message with spaces" }));
});
test("wire transport contains no SDK or collected browser/request context", async (t) => {
  const calls: Request[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => { calls.push(new Request(url, init)); return new Response(null, { status: 200 }); });
  await captureProduct({ POSTHOG_PROJECT_KEY: "synthetic_project_key" }, "tool_called", "account_fixture", { app_id: "calendar" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://eu.i.posthog.com/batch/");
  const wire = await calls[0]!.json() as Record<string, unknown>;
  delete wire.api_key; // Transport authentication is not an event property.
  assertPrivate(wire);
  await captureProduct({}, "sign_up", "account_fixture");
  await captureProduct({ POSTHOG_PROJECT_KEY: "synthetic_project_key" }, "sign_up", "fixture@example.invalid");
  assert.equal(calls.length, 1);
});
test("telemetry routes and errors cannot carry URL segments or exception messages", () => {
  assert.equal(pageTemplate("/setup/claim/private-token?email=hidden#secret"), "/setup/claim/:token");
  assert.equal(pageTemplate("/apps/private-content"), "/apps/:id");
  assert.equal(pageTemplate("/something/private-content"), "/other");
  assert.equal(pageTemplate("https://example.invalid/private"), "/other");
  assert.deepEqual(recentErrors([{code:"script_error"},{code:"secret-content"},{code:"http_503"},{code:"error@example.invalid"}]), [{code:"script_error"},{code:"http_503"}]);
});

test("regional configuration selects the exact ingest host and rejects arbitrary destinations", async (t) => {
  const calls: Request[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(new Request(url, init)); return new Response(null, { status: 200 });
  });
  const events = [{ event: "sign_up", accountId: "account_fixture" }] as const;
  for (const region of ["us", "eu"]) {
    assert.equal(await captureProducts({ POSTHOG_PROJECT_KEY: "synthetic", POSTHOG_HOST: `https://${region}.i.posthog.com` }, events), true);
    assert.equal(calls.at(-1)!.url, `https://${region}.i.posthog.com/batch/`);
    assert.equal(calls.at(-1)!.redirect, "manual");
  }
  for (const host of ["http://us.i.posthog.com", "https://us.i.posthog.com.evil.invalid", "https://us.i.posthog.com/private", "https://user@us.i.posthog.com", ""]) {
    assert.equal(await captureProducts({ POSTHOG_PROJECT_KEY: "synthetic", POSTHOG_HOST: host }, events), false);
  }
  assert.equal(calls.length, 2);
});
