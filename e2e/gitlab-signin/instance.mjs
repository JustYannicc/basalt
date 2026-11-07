import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

export const restToken = "glpat-synthetic-rest";
const mcpToken = "synthetic-gitlab-mcp";
const json = (response, body, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const read = async (request) => {
  let value = "";
  for await (const chunk of request) value += chunk;
  return value;
};
const escape = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * One self-managed GitLab instance on its own origin: REST with a personal access token, and an
 * MCP server that accepts only its mcp-scoped OAuth token. Registration exists only when `dcr`.
 */
export async function startGitLabInstance({ dcr }) {
  const calls = [];
  const failures = [];
  const codes = new Map();
  let registrations = 0;
  let origin;
  const document = () => ({
    openapi: "3.0.3",
    info: { title: "GitLab fixture", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/fixture/read": {
        get: {
          operationId: "fixture_read",
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  });
  const handle = async (request, response) => {
    const url = new URL(request.url, origin);
    const authorization = request.headers.authorization;
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, {
        resource: `${origin}/api/v4/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp", "api", "read_api", "read_user"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        ...(dcr ? { registration_endpoint: `${origin}/oauth/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp", "api", "read_api", "read_user"],
      });
    if (url.pathname === "/oauth/register") {
      assert.ok(dcr, "Registration must not be attempted where it is not advertised");
      const input = JSON.parse(await read(request));
      registrations++;
      calls.push({ transport: "oauth", phase: "register", scope: input.scope });
      return json(
        response,
        { ...input, client_id: "synthetic-gitlab-client", token_endpoint_auth_method: "none" },
        201,
      );
    }
    if (url.pathname === "/oauth/authorize") {
      const decision = url.searchParams.get("decision");
      if (decision === null) {
        calls.push({
          transport: "oauth",
          phase: "authorize",
          scope: url.searchParams.get("scope"),
          resource: url.searchParams.get("resource"),
        });
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>GitLab authorization fixture</title>
          <h1>GitLab test instance</h1><p>Synthetic authorization. No real account is used.</p><form action="/oauth/authorize">
          ${[...url.searchParams].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("")}
          <button name="decision" value="approve">Authorize</button></form>`);
        return;
      }
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", url.searchParams.get("state"));
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge"),
        redirect: url.searchParams.get("redirect_uri"),
      });
      callback.searchParams.set("code", code);
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    if (url.pathname === "/oauth/token") {
      const input = new URLSearchParams(await read(request));
      const code = codes.get(input.get("code"));
      assert.ok(code, "An issued, unused authorization code is required");
      assert.equal(input.get("redirect_uri"), code.redirect);
      assert.equal(
        createHash("sha256")
          .update(input.get("code_verifier") ?? "")
          .digest("base64url"),
        code.challenge,
      );
      codes.delete(input.get("code"));
      calls.push({ transport: "oauth", phase: "token" });
      return json(response, {
        access_token: mcpToken,
        token_type: "Bearer",
        refresh_token: "synthetic-gitlab-refresh",
        scope: "mcp",
        expires_in: 7200,
      });
    }
    if (url.pathname === "/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v3.yaml")
      return json(response, document());
    if (url.pathname === "/api/v4/mcp") {
      if (authorization !== `Bearer ${mcpToken}`) {
        response.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/v4/mcp"`,
        );
        return json(response, { error: "Unauthorized" }, 401);
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const message = JSON.parse(await read(request));
      calls.push({ transport: "mcp", method: message.method, tool: message.params?.name });
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      const result = (value) => json(response, { jsonrpc: "2.0", id: message.id, result: value });
      if (message.method === "initialize")
        return result({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "GitLab fixture", version: "1" },
        });
      if (message.method === "tools/list")
        return result({
          tools: [
            {
              name: "search",
              description: "Search fixture projects.",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
            {
              name: "create_issue",
              description: "Create a fixture issue.",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: false },
            },
          ],
        });
      if (message.method === "tools/call")
        return result({
          content: [{ type: "text", text: JSON.stringify({ transport: "mcp" }) }],
          isError: false,
        });
      return result({});
    }
    // REST accepts the personal access token header and refuses the MCP token.
    calls.push({
      transport: "rest",
      path: url.pathname,
      personalToken: request.headers["private-token"] === restToken,
      mcpToken: authorization === `Bearer ${mcpToken}`,
    });
    if (request.headers["private-token"] !== restToken)
      return json(response, { message: "401 Unauthorized" }, 401);
    if (url.pathname === "/api/v4/user")
      return json(response, { id: 7, username: "synthetic", web_url: `${origin}/synthetic` });
    if (url.pathname === "/fixture/read")
      return json(response, { transport: "rest", site: origin });
    return json(response, { message: "404 Not Found" }, 404);
  };
  const server = createServer((request, response) =>
    Promise.resolve(handle(request, response)).catch((error) => {
      failures.push({
        path: new URL(request.url, "http://localhost").pathname,
        error: String(error),
      });
      json(response, { error: "Fixture rejected request" }, 500);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    calls,
    failures,
    registrations: () => registrations,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
