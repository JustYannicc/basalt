import assert from "node:assert/strict";
import { once } from "node:events";

/** Local model-key headers never become the hosted native grant or tool/operator authority. */
export async function verifyNativeLocalHeaders({ origin, token, WebSocket }) {
  const headers = { "x-api-key": token, authorization: "Bearer synthetic.provider.login" };
  const response = await fetch(`${origin}/v1/models?client_version=0.166.0`, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).path, "/v1/models");
  const websocket = new WebSocket(origin.replace("http:", "ws:") + "/v1/responses", { headers });
  websocket.on("error", () => {});
  try {
    await once(websocket, "open");
    const received = once(websocket, "message");
    websocket.send("local-header-round-trip");
    assert.equal((await received)[0].toString(), "local-header-round-trip");
    const closed = once(websocket, "close");
    websocket.close();
    await closed;
  } finally {
    websocket.terminate();
  }
  for (const [path, refusedHeaders] of [
    ["/v1/models", { "x-api-key": "invalid", authorization: `Bearer ${token}` }],
    ["/mcp", { "x-api-key": token }],
    ["/client/status", { "x-api-key": token }],
  ]) {
    const refused = await fetch(`${origin}${path}`, { headers: refusedHeaders });
    assert.equal(refused.status, 401);
    await refused.body?.cancel();
  }
  return { models: true, websocket: true, refusals: 3 };
}
