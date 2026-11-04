import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    Promise.resolve(handler(request, response)).catch(() =>
      json(response, { error: "Fixture rejected the request" }, 500),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
};

/** Separate origins reject a token sent through the other transport. */
export async function startElevenLabsFixture() {
  const calls = [];
  const documents = new Map();
  let product;
  let challenge;
  let issuedClient;
  const scopes = ["convai_read", "convai_write", "text_to_speech", "speech_history_read", "flows", "image_video_generation", "voice_generation", "ads_read"];
  const credential = (request) =>
    request.headers["xi-api-key"] === "synthetic-elevenlabs-rest" ? "rest" :
    ({
            "Bearer synthetic-elevenlabs-oauth": "oauth",
    })[request.headers.authorization] ?? (request.headers.authorization ? "other" : "none");
  const rest = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (documents.has(url.pathname)) return json(response, documents.get(url.pathname));
    calls.push({ transport: "rest", path: url.pathname, credential: credential(request) });
    if (credential(request) !== "rest")
      return json(response, { error: { invalidToken: true } }, 403);
    if (url.pathname === "/v1/user")
      return json(response, { user_id: "synthetic-elevenlabs-user" });
    if (url.pathname === "/fixture/read")
      return json(response, { transport: "rest", marker: "retained-token" });
    if (url.pathname === "/fixture/write")
      return json(response, { transport: "rest", marker: "written" });
    return json(response, { error: "Unknown REST route" }, 404);
  });
  let registered = 0;
  let issued = 0;
  const mcp = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, {
        resource: `${mcp.origin}/mcp`,
        authorization_servers: [mcp.origin],
        scopes_supported: scopes,
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, {
        issuer: mcp.origin,
        authorization_endpoint: `${mcp.origin}/authorize`,
        token_endpoint: `${mcp.origin}/token`,
        client_id_metadata_document_supported: true,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: scopes,
      });
    if (url.pathname === "/register") {
      registered++;
      return json(response, { error: "No client registration supported" }, 404);
    }
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("resource"), `${mcp.origin}/mcp`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      challenge = url.searchParams.get("code_challenge");
      issuedClient = url.searchParams.get("client_id");
      assert.equal(issuedClient, "https://elevenlabs-host.example/oauth/client-metadata.json");
      const metadataResponse = await fetch(`${product}/oauth/client-metadata.json`, { redirect: "manual" });
      assert.equal(metadataResponse.status, 200);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.client_id, issuedClient);
      assert.ok(metadata.redirect_uris.includes(url.searchParams.get("redirect_uri")));
      assert.deepEqual(new Set(url.searchParams.get("scope").split(" ")), new Set(scopes));
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", "synthetic-elevenlabs-code");
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      const input = new URLSearchParams(await body(request));
      assert.equal(input.get("code"), "synthetic-elevenlabs-code");
      assert.equal(createHash("sha256").update(input.get("code_verifier")).digest("base64url"), challenge);
      assert.equal(input.get("client_id"), issuedClient);
      issued++;
      return json(response, {
        access_token: "synthetic-elevenlabs-oauth",
        token_type: "Bearer",
        refresh_token: "synthetic-elevenlabs-refresh",
        scope: scopes.join(" "),
        expires_in: 3600,
      });
    }
    if (url.pathname !== "/mcp") return json(response, { error: "Unknown MCP route" }, 404);
    const auth = credential(request);
    if (auth !== "oauth") {
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
      credential: auth,
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
        serverInfo: { name: "ElevenLabs fixture", version: "1" },
      });
    if (message.method === "tools/list")
      return result({
        tools: [
          {
            name: "list_voices",
            description: "Read the synthetic project.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
          },
          {
            name: "generate_audio",
            description: "Generate synthetic audio without spending real credits.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: false, destructiveHint: false },
          },
        ],
      });
    if (message.method === "tools/call")
      return result({
        content: [
          { type: "text", text: JSON.stringify({ transport: "mcp", marker: message.params.name }) },
        ],
        isError: false,
      });
    return result({});
  });
  return {
    rest: rest.origin,
    mcp: `${mcp.origin}/mcp`,
    documents,
    setProduct: (origin) => { product = origin; },
    calls,
    registrations: () => registered,
    exchanges: () => issued,
    stop: () => Promise.all([rest.stop(), mcp.stop()]),
  };
}
