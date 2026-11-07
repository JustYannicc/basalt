import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { appsVersion, mcpSdkVersion } from "../../.upstream/e2e/support/apps-release.ts";
import { localOpenapi } from "../openapi-fixture.mjs";
import { startManagementProvider } from "./provider.mjs";
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
  let document;
  const localize = async (source) => {
    const localized = await localOpenapi(
      source.files
        .filter((file) => file.path !== "package.json")
        .map((file) => ({
          ...file,
          content: file.content
            .replaceAll("https://api.workos.com", provider.rest)
            .replaceAll(
              'hosts: ["api.workos.com"]',
              `hosts: [${JSON.stringify(new URL(provider.rest).host)}]`,
            )
            .replaceAll("https://mcp.workos.com/mcp", provider.mcp)
            .replaceAll(
              'hosts: ["mcp.workos.com"]',
              `hosts: [${JSON.stringify(new URL(provider.mcp).host)}]`,
            ),
        })),
      origin,
      "workos",
    );
    document = localized.document;
    document.servers = [{ url: provider.rest }];
    document.paths["/fixture/write"] = {
      post: {
        operationId: "fixture_write",
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    };
    return {
      ...source,
      files: [
        ...localized.files,
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
            ? { version: 1, apps: [entry] }
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
  origin = `http://127.0.0.1:${server.address().port}`;
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
