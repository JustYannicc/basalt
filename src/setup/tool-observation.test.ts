import assert from "node:assert/strict";
import { test } from "node:test";
import { observeToolCall } from "./tool-observation.ts";
import { openEnvelope } from "../pool/token.ts";

const secret = "ab".repeat(32);
const token = "fixture-tools-token";
async function observe(result: unknown, format = "json", method = "tools/call") {
  const writes: unknown[] = [];
  const request = new Request("https://app.signalbox.run/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method, params: { name: "search", arguments: { query: "fixture" } } }),
  });
  const response = new Response(format === "json" ? JSON.stringify(result) : `event: message\ndata: ${JSON.stringify(result)}\n\n`, {
    headers: { "Content-Type": format === "json" ? "application/json" : "text/event-stream" },
  });
  await observeToolCall(request, response, {
    POOL_APP_SIGNING_KEY: secret,
    TOOLS_SERVICE: { fetch: async () => { throw new Error("unexpected tools call"); } },
    POOL_SERVICE: { fetch: async (request) => {
      const body = await request.json() as { envelope: string };
      writes.push(await openEnvelope(secret, "sbs1", body.envelope));
      return Response.json(null);
    } },
  });
  return writes;
}
test("successful JSON and SSE tool calls record only a digest, never tool contents or the token", async () => {
  for (const format of ["json", "sse"]) {
    const writes = await observe({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "fixture result" }] } }, format);
    assert.equal(writes.length, 1);
    const write = writes[0] as Record<string, unknown>;
    assert.equal(write.action, "observed");
    assert.match(String(write.tokenHash), /^[a-f0-9]{64}$/);
    assert.ok(Number(write.expiresAt) > Date.now());
    assert.doesNotMatch(JSON.stringify(writes), /fixture|search|arguments/);
  }
});
test("RPC errors, isError results, wrong correlation and non-call traffic never turn a computer green", async () => {
  for (const reply of [
    { id: 4, error: { code: -1 } },
    { id: 4, result: { isError: true, content: [] } },
    { id: 9, result: { content: [] } },
  ]) assert.deepEqual(await observe(reply), []);
  assert.deepEqual(await observe({ id: 4, result: { content: [] } }, "json", "tools/list"), []);
});
