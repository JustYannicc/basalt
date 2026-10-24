import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { URL } from "node:url";

const definitions = {
  gitlab: {
    tokenHeader: "private-token",
    tokens: {
      first: "synthetic-gitlab-first-token",
      second: "synthetic-gitlab-second-token",
    },
    spec(origin) {
      return {
        openapi: "3.0.3",
        info: { title: "GitLab local proof API", version: "fixture" },
        paths: {
          "/api/v4/projects": {
            get: {
              operationId: "getApiV4Projects",
              tags: ["Projects"],
              summary: "List fixture projects for the current account",
              responses: {
                "200": {
                  description: "Projects",
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "integer" },
                            name: { type: "string" },
                            path_with_namespace: { type: "string" },
                            web_url: { type: "string", format: "uri" },
                          },
                          required: ["id", "name", "path_with_namespace", "web_url"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          securitySchemes: {
            apiKey: { type: "apiKey", in: "header", name: "PRIVATE-TOKEN" },
          },
        },
        servers: [{ url: origin }],
      };
    },
    healthPath: "/api/v4/user",
    toolPath: "/api/v4/projects",
    operationName: "projects.getApiV4Projects",
    result(principal, origin) {
      const marker = `synthetic_gitlab_${principal}_project`;
      return {
        id: principal === "first" ? 4101 : 4102,
        name: marker,
        path_with_namespace: `fixture/${principal}/${marker}`,
        web_url: `${origin}/fixture/${principal}/${marker}`,
      };
    },
  },
  miro: {
    tokenHeader: "authorization",
    tokens: {
      first: "synthetic-miro-first-token",
      second: "synthetic-miro-second-token",
    },
    spec(origin) {
      return {
        openapi: "3.0.3",
        info: { title: "Miro local proof API", version: "fixture" },
        paths: {
          "/boards": {
            get: {
              operationId: "getBoards",
              tags: ["Boards"],
              summary: "List fixture boards for the current account",
              responses: {
                "200": {
                  description: "Boards",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          data: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                id: { type: "string" },
                                name: { type: "string" },
                              },
                              required: ["id", "name"],
                            },
                          },
                          total: { type: "integer" },
                        },
                        required: ["data", "total"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          securitySchemes: {
            oAuth2AuthCode: { type: "http", scheme: "bearer" },
          },
        },
        servers: [{ url: `${origin}/v2` }],
      };
    },
    healthPath: "/v1/oauth-token",
    toolPath: "/v2/boards",
    operationName: "boards.getBoards",
    result(principal) {
      const marker = `synthetic_miro_${principal}_board`;
      return {
        data: [{ id: `board-${principal}`, name: marker }],
        total: 1,
      };
    },
  },
};

const send = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

/** A loopback API and minimal OpenAPI document; it never forwards requests off-host. */
export async function startProviderFixture(kind) {
  const definition = definitions[kind];
  assert.ok(definition, `Unknown provider fixture: ${kind}`);
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === `/spec/${kind}.json`) {
      requests.push({ kind: "spec", method: request.method, path: url.pathname });
      return send(response, 200, definition.spec(origin));
    }

    const header = request.headers[definition.tokenHeader];
    const credential = kind === "miro" && typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : header;
    const principal = Object.entries(definition.tokens).find(([, token]) => token === credential)?.[0];
    requests.push({
      kind: "api",
      method: request.method ?? "GET",
      path: url.pathname,
      authHeader: definition.tokenHeader,
      principal: principal ?? "unknown",
    });
    if (principal === undefined) return send(response, 401, { error: "unknown synthetic credential" });

    if (request.method === "GET" && url.pathname === definition.healthPath) {
      if (kind === "gitlab") {
        return send(response, 200, {
          id: principal === "first" ? 1101 : 1102,
          username: `fixture_${principal}`,
          web_url: `${origin}/fixture_${principal}`,
        });
      }
      return send(response, 200, {
        user: { id: `miro-user-${principal}`, name: `Fixture ${principal}` },
      });
    }

    if (request.method === "GET" && url.pathname === definition.toolPath) {
      const value = definition.result(principal, origin);
      return send(response, 200, kind === "gitlab" ? [value] : value);
    }

    return send(response, 404, { error: "unmocked local route" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object", "Fixture server must expose a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    kind,
    origin,
    host: new URL(origin).host,
    definition,
    requests,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
