import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

const json = (response, body, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const body = async (request) => {
  let value = "";
  for await (const chunk of request) value += chunk;
  return value;
};
const listen = async (handler) => {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => json(response, { error: "Fixture rejected the request" }, 500));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { origin: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
};

/** Separate origins reject a token sent through the other transport. */
export async function startVercelFixture() {
  const calls = [];
  const documents = new Map();
  const credential = (request) => ({
    "Bearer synthetic-vercel-rest": "rest",
    "Bearer synthetic-vercel-oauth": "oauth",
  })[request.headers.authorization] ?? (request.headers.authorization ? "other" : "none");
  const rest = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (documents.has(url.pathname)) return json(response, documents.get(url.pathname));
    calls.push({ transport: "rest", path: url.pathname, credential: credential(request) });
    if (credential(request) !== "rest") return json(response, { error: { invalidToken: true } }, 403);
    if (url.pathname === "/v2/user") return json(response, { user: {
      id: "synthetic-vercel-user", username: "fixture", email: "fixture@example.test",
    } });
    if (url.pathname === "/fixture/read") return json(response, { transport: "rest", marker: "retained-token" });
    if (url.pathname === "/fixture/write") return json(response, { transport: "rest", marker: "written" });
    return json(response, { error: "Unknown REST route" }, 404);
  });
  let registered = 0;
  let issued = 0;
  const mcp = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(response, {
      resource: `${mcp.origin}/mcp`, authorization_servers: [mcp.origin], scopes_supported: ["read", "offline_access"],
    });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json(response, {
      issuer: mcp.origin, authorization_endpoint: `${mcp.origin}/authorize`, token_endpoint: `${mcp.origin}/token`,
      registration_endpoint: `${mcp.origin}/register`, response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
      scopes_supported: ["read", "offline_access"],
    });
    if (url.pathname === "/register") {
      const input = JSON.parse(await body(request));
      assert.ok(input.redirect_uris.length > 0);
      registered++;
      return json(response, { ...input, client_id: "synthetic-vercel-client", token_endpoint_auth_method: "none" }, 201);
    }
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("resource"), `${mcp.origin}/mcp`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", "synthetic-vercel-code");
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      const input = new URLSearchParams(await body(request));
      assert.equal(input.get("code"), "synthetic-vercel-code");
      assert.ok(input.get("code_verifier"));
      issued++;
      return json(response, { access_token: "synthetic-vercel-oauth", token_type: "Bearer",
        refresh_token: "synthetic-vercel-refresh", scope: "read offline_access", expires_in: 3600 });
    }
    if (url.pathname !== "/mcp") return json(response, { error: "Unknown MCP route" }, 404);
    const auth = credential(request);
    if (auth !== "oauth") {
      response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${mcp.origin}/.well-known/oauth-protected-resource"`);
      return json(response, { error: "Unauthorized" }, 401);
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const message = JSON.parse(await body(request));
    calls.push({ transport: "mcp", method: message.method, tool: message.params?.name, credential: auth });
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = (value) => json(response, { jsonrpc: "2.0", id: message.id, result: value });
    if (message.method === "initialize") return result({ protocolVersion: "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "Vercel fixture", version: "1" } });
    if (message.method === "tools/list") return result({ tools: [
      { name: "read_project", description: "Read the synthetic project.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
      { name: "delete_project", description: "Delete the synthetic project.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: true } },
    ] });
    if (message.method === "tools/call") return result({ content: [{ type: "text",
      text: JSON.stringify({ transport: "mcp", marker: message.params.name }) }], isError: false });
    return result({});
  });
  return { rest: rest.origin, mcp: `${mcp.origin}/mcp`, documents, calls,
    registrations: () => registered, exchanges: () => issued,
    stop: () => Promise.all([rest.stop(), mcp.stop()]) };
}
