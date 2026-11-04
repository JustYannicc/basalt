import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const json = (response, status, value, headers = {}) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
};

/** A small AWS MCP and OAuth server. Requests remain local and use synthetic identities. */
export async function startAwsFixture({ clientName }) {
  const expectedLoopbackCallback = "http://127.0.0.1:43119/oauth/callback";
  const events = {
    registrations: [],
    authorizations: [],
    exchanges: [],
    refreshes: [],
    staleRefreshAttempts: [],
    mcp: [],
  };
  const clients = new Map();
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const retiredRefresh = new Map();
  let nextGrant = 0;
  let allowCallbacks = false;
  let acceptedCallback;
  let origin;
  let host;

  const tools = [
    {
      name: "get_caller_identity",
      description: "Read the caller's AWS identity.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "call_aws",
      description: "Call an AWS service operation with the caller's permissions.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string" },
          operation: { type: "string" },
          parameters: { type: "object" },
        },
        required: ["service", "operation"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "execute_script",
      description: "Run an AWS script with the caller's permissions.",
      inputSchema: {
        type: "object",
        properties: { script: { type: "string" } },
        required: ["script"],
        additionalProperties: false,
      },
    },
  ];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return json(response, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server")
        return json(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });

      if (url.pathname === "/mcp" && request.method === "GET") {
        return response
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
      }

      if (url.pathname === "/register" && request.method === "POST") {
        const input = JSON.parse(await bodyOf(request));
        assert.equal(input.token_endpoint_auth_method, "none", "AWS uses a public OAuth client");
        assert.deepEqual(input.grant_types, ["authorization_code", "refresh_token"]);
        assert.deepEqual(input.response_types, ["code"]);
        assert.equal(input.scope, undefined, "AWS publishes no OAuth scope strings");
        assert.equal(
          input.client_name,
          clientName,
          "OAuth registration must identify the host product",
        );
        assert.equal(
          input.application_type,
          "native",
          "AWS Sign-In must receive a native loopback client",
        );
        const callbacks = input.redirect_uris ?? [];
        acceptedCallback = callbacks[0];
        events.registrations.push({
          clientName: input.client_name,
          clientType: input.token_endpoint_auth_method,
          grantTypes: input.grant_types,
          scopeCount: input.scope ? input.scope.split(" ").length : 0,
          callbacks: callbacks.map((value) => {
            const callback = new URL(value);
            return `${callback.origin}${callback.pathname}`;
          }),
        });
        if (!callbacks.every((callback) => allowCallbacks && callback === expectedLoopbackCallback))
          return json(response, 400, {
            error: "invalid_redirect_uri",
            error_description: "The redirect URI is not on the provider allowlist.",
          });
        const id = `fixture-client-${clients.size + 1}`;
        clients.set(id, { redirectUris: callbacks });
        return json(response, 201, {
          client_id: id,
          token_endpoint_auth_method: "none",
          redirect_uris: callbacks,
        });
      }

      if (url.pathname === "/authorize" && request.method === "GET") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const resource = url.searchParams.get("resource") ?? "";
        const client = clients.get(clientId);
        assert.ok(
          client?.redirectUris.includes(redirectUri),
          "Authorization used an unregistered callback",
        );
        assert.ok(state.length > 0, "Authorization did not include OAuth state");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.ok(challenge.length > 0, "Authorization did not include a PKCE challenge");
        assert.equal(resource, `${origin}/mcp`, "Authorization targeted a different MCP resource");
        const actor = url.searchParams.get("fixture_actor") ?? "owner";
        assert.ok(
          actor === "owner" || actor === "member" || actor === "owner-reconnected",
          "Fixture authorization needs a synthetic actor",
        );
        const code = randomUUID();
        codes.set(code, { actor, clientId, redirectUri, state, challenge, resource });
        events.authorizations.push({ actor, clientId, resource, pkce: "S256" });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        return response.writeHead(302, { location: callback.href }).end();
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const input = new URLSearchParams(await bodyOf(request));
        assert.equal(
          request.headers.authorization,
          undefined,
          "Public clients do not send a secret",
        );
        assert.equal(input.get("client_secret"), null, "Public clients do not send a secret");
        const clientId = input.get("client_id") ?? "";
        if (input.get("grant_type") === "authorization_code") {
          const grant = codes.get(input.get("code") ?? "");
          assert.ok(grant, "Token exchange used an unknown code");
          assert.equal(grant.clientId, clientId);
          assert.equal(grant.redirectUri, input.get("redirect_uri"));
          assert.equal(grant.resource, input.get("resource"));
          assert.equal(
            createHash("sha256")
              .update(input.get("code_verifier") ?? "")
              .digest("base64url"),
            grant.challenge,
            "Token exchange did not prove the registered PKCE challenge",
          );
          codes.delete(input.get("code") ?? "");
          const grantId = ++nextGrant;
          const token = `aws-fixture-access-${grant.actor}-${randomUUID()}`;
          const refreshToken = `aws-fixture-refresh-${grant.actor}-${randomUUID()}`;
          access.set(token, grant.actor);
          refresh.set(refreshToken, { actor: grant.actor, grantId, generation: 0 });
          events.exchanges.push({
            actor: grant.actor,
            clientId,
            resource: grant.resource,
            pkce: true,
            grantId,
            refreshGeneration: 0,
          });
          return json(response, 200, {
            access_token: token,
            token_type: "Bearer",
            expires_in: 20,
            refresh_token: refreshToken,
          });
        }
        if (input.get("grant_type") === "refresh_token") {
          const presentedToken = input.get("refresh_token") ?? "";
          const current = refresh.get(presentedToken);
          if (!current) {
            const retired = retiredRefresh.get(presentedToken);
            if (retired) events.staleRefreshAttempts.push({ ...retired });
            return json(response, 400, { error: "invalid_grant" });
          }
          assert.equal(input.get("resource"), `${origin}/mcp`);
          const token = `aws-fixture-access-${current.actor}-${randomUUID()}`;
          const refreshToken = `aws-fixture-refresh-${current.actor}-${randomUUID()}`;
          const generation = current.generation + 1;
          refresh.delete(presentedToken);
          retiredRefresh.set(presentedToken, {
            actor: current.actor,
            grantId: current.grantId,
            generation: current.generation,
          });
          refresh.set(refreshToken, { ...current, generation });
          access.set(token, current.actor);
          events.refreshes.push({
            actor: current.actor,
            clientId,
            grantId: current.grantId,
            previousGeneration: current.generation,
            issuedGeneration: generation,
          });
          return json(response, 200, {
            access_token: token,
            token_type: "Bearer",
            expires_in: 20,
            refresh_token: refreshToken,
          });
        }
        return json(response, 400, { error: "unsupported_grant_type" });
      }

      if (url.pathname === "/mcp" && request.method === "POST") {
        const actor = access.get(
          (/^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "") ?? [])[1],
        );
        if (!actor) return response.writeHead(401).end();
        const message = JSON.parse(await bodyOf(request));
        events.mcp.push({ actor, method: message.method, tool: message.params?.name });
        if (message.method === "notifications/initialized" || message.id === undefined)
          return response.writeHead(202).end();
        if (message.method === "initialize")
          return json(response, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "aws-mcp-fixture", version: "1" },
            },
          });
        if (message.method === "tools/list")
          return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { tools } });
        if (message.method === "tools/call") {
          const name = message.params?.name;
          if (!tools.some((tool) => tool.name === name))
            return json(response, 200, {
              jsonrpc: "2.0",
              id: message.id,
              result: { isError: true, content: [{ type: "text", text: "Unknown fixture tool" }] },
            });
          const input = message.params?.arguments ?? {};
          return json(response, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ actor, tool: name, input }) }],
              structuredContent: { actor, tool: name, input },
            },
          });
        }
        return json(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      events.mcp.push({ tool: "fixture-assertion", message: String(error?.message ?? error) });
      return json(response, 400, { error: "Synthetic AWS fixture rejected the request." });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const listening = server.address();
  assert.ok(
    listening && typeof listening === "object",
    "Fixture server did not expose its TCP address",
  );
  const endpoint = new URL("http://127.0.0.1");
  endpoint.port = String(listening.port);
  origin = endpoint.origin;
  host = endpoint.host;
  return {
    origin,
    host,
    setCallbacksAllowed(value) {
      allowCallbacks = value;
    },
    callbackUri() {
      return acceptedCallback;
    },
    expectedCallback: expectedLoopbackCallback,
    observations() {
      return structuredClone(events);
    },
    async approve(authorizationUrl, actor) {
      const authorize = new URL(authorizationUrl);
      assert.equal(authorize.origin, origin, "OAuth authorization escaped the local fixture");
      authorize.searchParams.set("fixture_actor", actor);
      const result = await fetch(authorize, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(result.status, 302, "The local OAuth fixture did not redirect to its callback");
      const location = result.headers.get("location");
      assert.ok(location, "The local OAuth fixture omitted its callback URI");
      return location;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
