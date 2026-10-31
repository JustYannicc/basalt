import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayUnavailable } from "../../src/pool/gateway-failure.ts";

test("a retryable refusal correlates the response, sanitized log and alert without request content", async () => {
  const background: Promise<unknown>[] = [], logs: unknown[][] = [], alerts: string[] = [];
  const originalFetch = globalThis.fetch, originalError = console.error;
  globalThis.fetch = async (_url, init) => {
    alerts.push(new TextDecoder().decode(init?.body as ArrayBuffer));
    return new Response(null, { status: 202 });
  };
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = gatewayUnavailable({ SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456" },
      new Request("https://pool.example/v1/responses?key=private-key", {
        method: "POST", body: "private-prompt", headers: { Authorization: "Bearer private-token" },
      }), undefined, performance.now(), (work) => { background.push(work); });
    await Promise.all(background);
    assert.equal(response.status, 503);
    const requestId = response.headers.get("X-Request-Id");
    assert.ok(requestId);
    assert.equal(response.headers.get("Retry-After"), "2");
    assert.match(JSON.stringify(logs), new RegExp(requestId));
    assert.equal(alerts.length, 1);
    const event = JSON.parse(alerts[0]!.trim().split("\n")[2]!) as { tags: Record<string, string>; message: string };
    assert.equal(event.message, "pool_failure");
    assert.equal(event.tags.request_id, requestId);
    assert.ok(!JSON.stringify([alerts, logs]).includes("private-"));
  } finally { globalThis.fetch = originalFetch; console.error = originalError; }
});
