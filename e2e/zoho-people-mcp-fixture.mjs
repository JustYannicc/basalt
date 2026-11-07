import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpsRequest } from "node:https";

const read = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};
const json = (response, value, status = 200, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};

/** A private HTTPS resource with its own OAuth issuer, DCR and synthetic People tools. */
export async function startZohoMcpFixture(tls) {
  const challenges = new Map();
  const clients = new Set();
  const calls = [];
  const counts = {
    requests: 0,
    connections: 0,
    registrations: 0,
    exchanges: 0,
    refreshes: 0,
    anonymous: 0,
    discoveryFailures: 0,
    tokenFailures: 0,
  };
  let discoveryFails = false;
  let tokenFails = false;
  let catalog;
  let endpoint;
  let origin;
  const tools = [
    {
      name: "readPeople",
      description: "Read synthetic People records",
      annotations: { readOnlyHint: true },
    },
    {
      name: "updatePeople",
      description: "Update synthetic People records",
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    { name: "unknownPeople", description: "A tool with no hints" },
    {
      name: "hiddenPeople",
      description: "Only an embedded app may call this",
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
  ].map((tool) => ({
    ...tool,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
  const server = createServer(tls, (request, response) => {
    void (async () => {
      counts.requests++;
      const url = new URL(request.url, origin);
      if (url.pathname === "/catalog/index.json" && catalog !== undefined)
        return json(response, { version: 1, apps: [catalog.entry] });
      if (url.pathname === "/catalog/apps/zoho-people.json" && catalog !== undefined)
        return json(response, catalog.source);
      if (discoveryFails && url.pathname.startsWith("/.well-known/")) {
        counts.discoveryFailures++;
        return json(response, { error: "Synthetic discovery failure" }, 503);
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return json(response, {
          resource: endpoint,
          authorization_servers: [origin],
          scopes_supported: ["people:tools"],
        });
      if (
        url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.startsWith("/.well-known/openid-configuration")
      )
        return json(response, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["people:tools"],
        });
      if (url.pathname === "/register") {
        const input = JSON.parse(await read(request));
        assert.equal(input.token_endpoint_auth_method, "none");
        const id = `synthetic-mcp-client-${++counts.registrations}`;
        clients.add(id);
        return json(response, { ...input, client_id: id }, 201);
      }
      if (url.pathname === "/authorize") {
        assert.ok(clients.has(url.searchParams.get("client_id")));
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("resource"), endpoint);
        const code = `synthetic-mcp-code-${challenges.size}`;
        challenges.set(code, url.searchParams.get("code_challenge"));
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("iss", origin);
        response.writeHead(302, { location: callback.href });
        response.end();
        return;
      }
      if (url.pathname === "/token") {
        if (tokenFails) {
          counts.tokenFailures++;
          return json(response, { error: "Synthetic token exchange failure" }, 503);
        }
        const body = new URLSearchParams(await read(request));
        assert.ok(clients.has(body.get("client_id")));
        assert.equal(body.get("resource"), endpoint);
        if (body.get("grant_type") === "refresh_token") {
          assert.equal(body.get("refresh_token"), "synthetic-mcp-refresh");
          counts.refreshes++;
        } else {
          assert.equal(
            createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
            challenges.get(body.get("code")),
          );
          counts.exchanges++;
        }
        return json(response, {
          access_token: "synthetic-mcp-access",
          refresh_token: "synthetic-mcp-refresh",
          token_type: "Bearer",
          scope: "people:tools",
          expires_in: 1,
        });
      }
      if (url.pathname !== new URL(endpoint).pathname || url.search !== new URL(endpoint).search)
        return json(response, { error: "Unknown resource" }, 404);
      if (request.headers.authorization !== "Bearer synthetic-mcp-access") {
        counts.anonymous++;
        return json(response, { error: "Sign in required" }, 401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        });
      }
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const message = JSON.parse(await read(request));
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      let result;
      if (message.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "Synthetic Zoho People MCP", version: "1" },
        };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "tools/call") {
        assert.ok(tools.some((tool) => tool.name === message.params.name));
        calls.push(message.params.name);
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({ tool: message.params.name, calls: calls.length }),
            },
          ],
        };
      } else
        return json(response, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported method" },
        });
      return json(response, { jsonrpc: "2.0", id: message.id, result });
    })().catch(() => json(response, { error: "Fixture contract failed" }, 500));
  });
  server.on("connection", () => counts.connections++);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = new URL("https://127.0.0.1");
  address.port = String(server.address().port);
  origin = address.origin;
  endpoint = `${origin}/private/synthetic-people-endpoint-marker/mcp?key=synthetic-private-query-marker`;
  return {
    origin,
    endpoint,
    calls,
    counts,
    failDiscovery: (value) => {
      discoveryFails = value;
    },
    failToken: (value) => {
      tokenFails = value;
    },
    setCatalog: (value) => {
      catalog = value;
    },
    approve: (url) =>
      new Promise((resolve, reject) => {
        const request = httpsRequest(url, { ca: tls.cert }, (response) => {
          response.resume();
          if (response.statusCode !== 302) return reject(new Error("Fixture consent failed"));
          resolve(response.headers.location);
        });
        request.on("error", reject);
        request.end();
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
