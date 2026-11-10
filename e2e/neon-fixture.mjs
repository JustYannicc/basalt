import { once } from "node:events";
import { createServer } from "node:http";

/** Each saved account gets its own synthetic key, so a call shows which account sent it. */
export const neonKey = (label) => `synthetic-neon-key-${label.toLowerCase().replaceAll(" ", "-")}`;
/** The account a synthetic key belongs to, safe to echo because it is not the key. */
export const keyAccount = (key) => key.slice(neonKey("").length);

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

/**
 * Neon's REST API and MCP server on separate origins. Both accept the same API key as a bearer
 * token, as Neon documents for its MCP server; anything else is refused. Calls record the key, and
 * tool results name the account whose key ran them; the host scrubs the key itself from results.
 */
export async function startNeonFixture() {
  const calls = [];
  const documents = new Map();
  const prefix = `Bearer ${neonKey("")}`;
  const credential = (request) =>
    request.headers.authorization?.startsWith(prefix) === true
      ? request.headers.authorization.slice("Bearer ".length)
      : request.headers.authorization === undefined
        ? "none"
        : "other";
  const rest = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (documents.has(url.pathname)) return json(response, documents.get(url.pathname));
    calls.push({
      transport: "rest",
      method: request.method,
      path: url.pathname,
      credential: credential(request),
    });
    if (!credential(request).startsWith(neonKey("")))
      return json(response, { message: "unauthorized" }, 401);
    if (url.pathname === "/api/v2/users/me") return json(response, { id: "synthetic-neon-user" });
    if (url.pathname === "/fixture/read")
      return json(response, { transport: "rest", account: keyAccount(credential(request)) });
    return json(response, { error: "Unknown REST route" }, 404);
  });
  const mcp = await listen(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/mcp") return json(response, { error: "Unknown MCP route" }, 404);
    const auth = credential(request);
    calls.push({ transport: "mcp", method: request.method, credential: auth });
    if (!auth.startsWith(neonKey(""))) return json(response, { error: "Unauthorized" }, 401);
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    const message = JSON.parse(await body(request));
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
        serverInfo: { name: "Neon fixture", version: "1" },
      });
    if (message.method === "tools/list")
      return result({
        tools: [
          {
            name: "list_projects",
            description: "List the synthetic projects.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    if (message.method === "tools/call")
      return result({
        content: [
          { type: "text", text: JSON.stringify({ transport: "mcp", account: keyAccount(auth) }) },
        ],
        isError: false,
      });
    return result({});
  });
  return {
    rest: rest.origin,
    mcp: `${mcp.origin}/mcp`,
    documents,
    calls,
    stop: () => Promise.all([rest.stop(), mcp.stop()]),
  };
}
