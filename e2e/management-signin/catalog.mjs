import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { appsVersion, mcpSdkVersion } from "../../.upstream/e2e/support/apps-release.ts";
import { startManagementProvider } from "./provider.mjs";
import { instanceGuideEntry, instanceGuideSource } from "./instance-guidance.mjs";
import { withManualGuidance } from "./manual-guidance.mjs";

/** The real catalog overlay, with only its publisher and vendor origins replaced. */
export async function startManagementCatalog() {
  const provider = await startManagementProvider();
  const baseline = JSON.parse(
    await readFile(new URL("../../src/catalog/workos.published.json", import.meta.url)),
  );
  const entry = {
    id: "workos",
    package: baseline.package,
    name: "WorkOS",
    description: "Manage WorkOS.",
    auth: [{ method: "apiKey", kind: "secrets", label: "API key" }],
    icons: [],
    source: "apps/workos.json",
  };
  let origin;
  const document = {
    openapi: "3.0.3",
    info: { title: "Synthetic management API", version: "1" },
    servers: [{ url: provider.rest }],
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
      "/fixture/write": {
        post: {
          operationId: "fixture_write",
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
  const localize = async (source) => {
    const files = source.files
      .filter((file) => file.path !== "package.json")
      .map((file) => ({
        ...file,
        content: file.content
          .replaceAll("https://api.workos.com", provider.rest)
          .replaceAll(
            "https://raw.githubusercontent.com/workos/openapi-spec/main/spec/open-api-spec.yaml",
            `${origin}/openapi/workos.json`,
          )
          .replaceAll(
            'hosts: ["api.workos.com"]',
            `hosts: [${JSON.stringify(new URL(provider.rest).host)}]`,
          )
          .replaceAll("https://mcp.workos.com/mcp", provider.mcp)
          .replaceAll(
            'hosts: ["mcp.workos.com"]',
            `hosts: [${JSON.stringify(new URL(provider.mcp).host)}]`,
          ),
      }));
    return {
      ...source,
      files: [
        ...files,
        {
          path: "package.json",
          content: JSON.stringify({
            name: source.package,
            dependencies: { apps: appsVersion, "@modelcontextprotocol/sdk": mcpSdkVersion },
          }),
        },
      ],
    };
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname === "/catalog/apps/instance-guide.json") {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify(instanceGuideSource));
      }
      if (url.pathname === "/openapi/workos.json") {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify(document));
      }
      if (!url.pathname.startsWith("/catalog/")) {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ data: [] }));
      }
      const result = await handleCatalog(new Request(url), async (upstream) =>
        Response.json(
          new URL(upstream).pathname.endsWith("index.json")
            ? { version: 1, apps: [entry, instanceGuideEntry] }
            : baseline,
        ),
      );
      let body = await result.text();
      if (url.pathname === "/catalog/index.json" && result.ok)
        body = JSON.stringify(withManualGuidance(JSON.parse(body)));
      if (url.pathname === "/catalog/apps/workos.json" && result.ok) {
        body = JSON.stringify(await localize(JSON.parse(body)));
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(body);
    } catch {
      response.writeHead(500);
      response.end("Management fixture failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = new URL("http://127.0.0.1");
  address.port = String(server.address().port);
  origin = address.origin;
  return {
    origin,
    provider,
    publishedFiles: async () => (await localize(baseline)).files,
    currentFiles: async () =>
      (await (await fetch(`${origin}/catalog/apps/workos.json`)).json()).files,
    stop: () =>
      Promise.all([
        provider.stop(),
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
      ]),
  };
}
