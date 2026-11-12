import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { appsVersion, mcpSdkVersion } from "../../.upstream/e2e/support/apps-release.ts";

const document = {
  openapi: "3.0.3",
  info: { title: "GitLab fixture", version: "1" },
  servers: [{ url: "https://gitlab.com" }],
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", name: "PRIVATE-TOKEN", in: "header" },
      http: { type: "http", scheme: "bearer" },
    },
  },
  security: [{ apiKey: [] }, { http: [] }],
  paths: {
    "/fixture/write": {
      post: { operationId: "fixture_write", responses: { 200: { description: "OK" } } },
    },
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
};

/**
 * Serve the real catalog source with local framework pins and a separate public definition.
 * Only the definition's transport changes; API calls still resolve against the saved account site.
 */
export async function startGitLabCatalog() {
  const entry = {
    id: "gitlab",
    package: "@executor.sh/gitlab",
    name: "GitLab",
    description: "GitLab.",
    auth: [],
    icons: [],
    source: "apps/gitlab.json",
  };
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/openapi/gitlab.json") {
        assert.equal(
          request.headers.authorization,
          undefined,
          "Public definitions omit OAuth credentials",
        );
        assert.equal(
          request.headers["private-token"],
          undefined,
          "Public definitions omit access tokens",
        );
        assert.equal(url.search, "", "Public definitions have no account query parameters");
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify(document));
      }
      if (!url.pathname.startsWith("/catalog/")) {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ data: [] }));
      }
      const result = await handleCatalog(new Request(url), async () =>
        Response.json({ version: 1, apps: [entry] }),
      );
      let body = await result.text();
      if (url.pathname === "/catalog/apps/gitlab.json" && result.ok) {
        const source = JSON.parse(body);
        body = JSON.stringify({
          ...source,
          files: source.files.map((file) => {
            if (file.path === "openapi.ts") {
              const publicSource =
                "https://gitlab.com/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v3.yaml";
              assert.equal(
                file.content.split(publicSource).length - 1,
                1,
                "The public definition source changed",
              );
              return {
                ...file,
                content: file.content.replace(publicSource, `${origin}/openapi/gitlab.json`),
              };
            }
            if (file.path !== "package.json") return file;
            const manifest = JSON.parse(file.content);
            return {
              ...file,
              content: JSON.stringify({
                ...manifest,
                dependencies: { apps: appsVersion, "@modelcontextprotocol/sdk": mcpSdkVersion },
              }),
            };
          }),
        });
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(body);
    } catch {
      response.writeHead(500);
      response.end("GitLab catalog fixture failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
