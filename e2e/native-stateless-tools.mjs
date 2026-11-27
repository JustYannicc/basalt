import assert from "node:assert/strict";

const revision = "2026-07-28";
const meta = {
  "io.modelcontextprotocol/protocolVersion": revision,
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A stateless 2026-07-28 client behind the device: the product routes it by its MCP headers. */
export async function verifyNativeStatelessTools({ origin, headers }) {
  const list = (routing) =>
    fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": revision,
        "user-agent": "native-stateless-proof/1",
        ...routing,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta },
      }),
    });
  // The product enforces the routing header, so its absence is refused rather than ignored.
  const unrouted = await list({});
  assert.ok(unrouted.status >= 400 && unrouted.status < 500, `unrouted status ${unrouted.status}`);
  await unrouted.body?.cancel();
  const listed = await list({ "mcp-method": "tools/list" });
  const text = await listed.text();
  assert.equal(listed.status, 200, text);
  assert.equal(listed.headers.get("mcp-session-id"), null, "A stateless call opens no session.");
  const data = listed.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line.length > 6)
        .at(-1)
        ?.slice(6)
    : text;
  const names = JSON.parse(data ?? "{}").result?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(names.includes("execute"), `listed tools: ${names.join(", ")}`);
  return { unroutedStatus: unrouted.status, tools: names.length };
}
