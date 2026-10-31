import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";

function rawLocalStatus(origin, path, headers, upgrade = false) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: url.hostname,
      port: url.port,
      method: "GET",
      path,
      headers: {
        ...headers,
        ...(upgrade
          ? {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              "sec-websocket-version": "13",
            }
          : {}),
      },
    });
    outgoing.on("error", reject);
    outgoing.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("upgrade", (response, socket) => {
      socket.on("error", () => {});
      socket.destroy();
      resolve(response.statusCode);
    });
    outgoing.end();
  });
}

/** Uses the public CLI listener and native tunnel; the grant comes from real hosted sign-in. */
export async function verifyNativeSearch({ worker, origin, headers, WebSocket }) {
  for (const [method, path, search] of [
    ["GET", "/v1/models", "?client_version=0.166.0"],
    ["GET", "/v1/models", "?limit=20&after_id=synthetic-model"],
    ["POST", "/v1/messages", "?beta=true"],
    ["POST", "/v1/messages/count_tokens", "?beta=true"],
    ["GET", "/v1/models", "?value=" + "x".repeat(2041)],
  ]) {
    const response = await fetch(`${origin}${path}${search}`, {
      method,
      headers,
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal(response.status, 200, `${method} ${path}${search}`);
    const body = await response.json();
    assert.equal(body.path, path);
    assert.equal(body.search, search);
  }
  const raw = (operation) => {
    assert.equal(
      typeof worker.accessToken(),
      "string",
      "The fixture observed the actual issued native grant.",
    );
    const socket = new WebSocket(
      worker.origin.replace("http:", "ws:") + "/native/v1/tunnel",
      "basalt.tunnel.v1",
      {
        headers: { authorization: `Bearer ${worker.accessToken()}` },
      },
    );
    socket.on("error", () => {});
    const frames = [],
      parts = [];
    socket.on("message", (bytes) => {
      const frame = JSON.parse(bytes.toString());
      frames.push(frame);
      if (frame.type === "ready") {
        socket.send(JSON.stringify({ v: 1, type: "open", id: 1, operation, headers: {} }));
        socket.send(JSON.stringify({ v: 1, type: "credit", id: 1, bytes: 65536 }));
      }
      if (frame.type === "data") parts.push(Buffer.from(frame.bytes, "base64"));
      if (frame.type === "end" || frame.type === "error") socket.close();
    });
    return { socket, frames, parts };
  };
  const valid = raw({
    service: "models",
    method: "GET",
    path: "/v1/models",
    transport: "http",
    search: "?client_version=%30.166.0&label=two%20words",
  });
  try {
    await once(valid.socket, "close", { signal: AbortSignal.timeout(10_000) });
    assert.ok(valid.frames.some((frame) => frame.type === "end"));
    const body = JSON.parse(Buffer.concat(valid.parts).toString());
    assert.equal(body.path, "/v1/models");
    assert.equal(
      body.search,
      "?client_version=0.166.0&label=two+words",
      "The server parses and re-serializes search.",
    );
  } finally {
    valid.socket.terminate();
  }
  const websocket = new WebSocket(
    origin.replace("http:", "ws:") + "/v1/responses?client_version=0.166.0",
    { headers },
  );
  websocket.on("error", () => {});
  try {
    await once(websocket, "open", { signal: AbortSignal.timeout(10_000) });
    const received = once(websocket, "message", { signal: AbortSignal.timeout(10_000) });
    websocket.send("request-target");
    const [bytes] = await received;
    assert.deepEqual(JSON.parse(bytes.toString()), {
      path: "/v1/responses",
      search: "?client_version=0.166.0",
    });
    const closed = once(websocket, "close", { signal: AbortSignal.timeout(10_000) });
    websocket.close();
    await closed;
  } finally {
    websocket.terminate();
  }
  const invalidSearches = [
    "?value=" + "x".repeat(2048),
    "?value=" + "é".repeat(500),
    "?value=%",
    "?value=%GG",
    "?value=%E0%A4%A",
    "?value=secret#fragment",
    "?value=%23fragment",
    "?value=%0Aheader",
    "?value=\\admin",
    "//attacker.invalid/v1/models",
    "../api/organizations",
    "?%2F..%2Fapi=organizations",
    "?",
    "",
    1,
    null,
  ];
  const refused = invalidSearches.map((search) => ({
    service: "models",
    method: "GET",
    path: "/v1/models",
    transport: "http",
    search,
  }));
  refused.push(
    { service: "models", method: "GET", path: "/api/organizations", transport: "http" },
    { service: "models", method: "DELETE", path: "/v1/models", transport: "http" },
    { service: "models", method: "GET", path: "/v1/models?client_version=1", transport: "http" },
    {
      service: "models",
      method: "GET",
      path: "/v1/../v1/models",
      transport: "http",
      search: "?client_version=1",
    },
    { service: "tools", method: "POST", path: "/mcp", transport: "http", search: "?beta=true" },
  );
  for (const operation of refused) {
    const before = worker.modelRequests().length;
    const invalid = raw(operation);
    try {
      const [code] = await once(invalid.socket, "close", { signal: AbortSignal.timeout(10_000) });
      assert.equal(code, 1008, JSON.stringify(operation));
      assert.deepEqual(
        invalid.frames.map((frame) => frame.type),
        ["ready"],
      );
      assert.equal(
        worker.modelRequests().length,
        before,
        "Refused input never reaches a model path.",
      );
    } finally {
      invalid.socket.terminate();
    }
  }
  for (const path of [
    "/v1/models?value=%GG",
    "/v1/models?value=" + "x".repeat(2048),
    "/mcp?beta=true",
    "/api/organizations?beta=true",
  ]) {
    const response = await fetch(`${origin}${path}`, { headers });
    assert.equal(response.status, 404);
    await response.body?.cancel();
  }
  const noSearch = {
    http: await rawLocalStatus(origin, "/v1/../v1/models", headers),
    websocket: await rawLocalStatus(origin, "/v1/../v1/responses", headers, true),
  };
  assert.deepEqual(
    noSearch,
    { http: 502, websocket: 403 },
    "Raw no-search targets retain their previous refusal.",
  );
  return {
    queries: 5,
    websocketQuery: true,
    rawNormalized: true,
    refusedOperations: refused.length,
    refusedLocalPaths: 4,
    noSearchRefusals: 2,
  };
}
