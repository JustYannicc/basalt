import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
const listen = async (handler, failures) => {
  const server = createServer((request, response) =>
    Promise.resolve(handler(request, response)).catch(() => {
      failures.push({ path: new URL(request.url, "http://localhost").pathname });
      json(response, { error: "Fixture rejected request" }, 500);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = new URL("http://127.0.0.1");
  address.port = String(server.address().port);
  return {
    origin: address.origin,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
};
const escape = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** The vendor boundary uses separate REST/MCP credentials and checks the actual PKCE verifier. */
export async function startManagementProvider() {
  const calls = [];
  const failures = [];
  const codes = new Map();
  let registrations = 0;
  let exchanges = 0;
  const rest = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    calls.push({
      transport: "rest",
      path: url.pathname,
      validCredential: request.headers.authorization === "Bearer sk_synthetic-workos-rest",
    });
    if (request.headers.authorization !== "Bearer sk_synthetic-workos-rest")
      return json(response, { error: "unauthorized" }, 401);
    if (url.pathname === "/organizations") return json(response, { data: [] });
    if (url.pathname === "/fixture/read")
      return json(response, { transport: "rest", retainedKey: true });
    return json(response, { error: "Unknown route" }, 404);
  }, failures);
  const mcp = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, {
        resource: `${mcp.origin}/mcp`,
        authorization_servers: [mcp.origin],
        scopes_supported: ["read", "write", "offline_access"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, {
        issuer: mcp.origin,
        authorization_endpoint: `${mcp.origin}/authorize`,
        token_endpoint: `${mcp.origin}/token`,
        registration_endpoint: `${mcp.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["read", "write", "offline_access"],
      });
    if (url.pathname === "/register") {
      const input = JSON.parse(await body(request));
      assert.ok(input.redirect_uris.length > 0);
      registrations++;
      return json(
        response,
        { ...input, client_id: "synthetic-management-client", token_endpoint_auth_method: "none" },
        201,
      );
    }
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("resource"), `${mcp.origin}/mcp`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const decision = url.searchParams.get("decision");
      if (decision === null) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>WorkOS authorization fixture</title>
          <h1>WorkOS test workspace</h1><p>Synthetic authorization. No real account is used.</p><form action="/authorize">
          ${[...url.searchParams].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("")}
          <button name="decision" value="approve">Approve access</button>
          <button name="decision" value="cancel">Cancel sign-in</button>
          <button name="decision" value="refuse">Refuse access</button></form>`);
        return;
      }
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", url.searchParams.get("state"));
      if (decision === "approve") {
        const code = randomBytes(16).toString("hex");
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge"),
          redirect: url.searchParams.get("redirect_uri"),
        });
        callback.searchParams.set("code", code);
      } else {
        callback.searchParams.set(
          "error",
          decision === "cancel" ? "access_denied" : "unauthorized_client",
        );
        callback.searchParams.set(
          "error_description",
          decision === "cancel"
            ? "Sign-in was cancelled."
            : "Your WorkOS team has disabled sign-in for connected tools. Ask a team admin to enable it in Authentication settings.",
        );
      }
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      const input = new URLSearchParams(await body(request));
      const code = codes.get(input.get("code"));
      calls.push({
        transport: "oauth",
        phase: "token-exchange",
        codeRecognized: code !== undefined,
        redirectProvided: input.has("redirect_uri"),
        expectedRedirectQueryKeys:
          code === undefined ? [] : [...new URL(code.redirect).searchParams.keys()],
        redirectMatches: input.get("redirect_uri") === code?.redirect,
        verifierMatches:
          createHash("sha256")
            .update(input.get("code_verifier") ?? "")
            .digest("base64url") === code?.challenge,
      });
      assert.ok(code, "An issued, unused authorization code is required");
      assert.equal(input.get("redirect_uri"), code.redirect);
      assert.equal(
        createHash("sha256")
          .update(input.get("code_verifier") ?? "")
          .digest("base64url"),
        code.challenge,
      );
      codes.delete(input.get("code"));
      exchanges++;
      return json(response, {
        access_token: "synthetic-management-oauth",
        token_type: "Bearer",
        refresh_token: "synthetic-management-refresh",
        scope: "read write offline_access",
        expires_in: 3600,
      });
    }
    if (url.pathname !== "/mcp") return json(response, { error: "Unknown route" }, 404);
    if (request.headers.authorization !== "Bearer synthetic-management-oauth") {
      response.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${mcp.origin}/.well-known/oauth-protected-resource"`,
      );
      return json(response, { error: "Unauthorized" }, 401);
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    const message = JSON.parse(await body(request));
    calls.push({
      transport: "mcp",
      method: message.method,
      tool: message.params?.name,
      validCredential: true,
    });
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
        serverInfo: { name: "WorkOS fixture", version: "1" },
      });
    if (message.method === "tools/list")
      return result({
        tools: [
          {
            name: "list_organizations",
            description: "List fixture organizations.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: "delete_organization",
            description: "Delete a fixture organization.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      });
    if (message.method === "tools/call")
      return result({
        content: [
          { type: "text", text: JSON.stringify({ transport: "mcp", tool: message.params.name }) },
        ],
        isError: false,
      });
    return result({});
  }, failures);
  return {
    rest: rest.origin,
    mcp: `${mcp.origin}/mcp`,
    calls,
    failures,
    registrations: () => registrations,
    exchanges: () => exchanges,
    stop: () => Promise.all([rest.stop(), mcp.stop()]),
  };
}
