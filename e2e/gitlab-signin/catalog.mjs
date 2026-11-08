import { once } from "node:events";
import { createServer } from "node:http";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { appsVersion, mcpSdkVersion } from "../../.upstream/e2e/support/apps-release.ts";

/**
 * The real catalog Worker with only its publisher replaced. The carried GitLab source is served
 * unchanged apart from its framework pins, so the product resolves every URL on the account's
 * chosen instance exactly as it would for a self-managed GitLab.
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
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
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
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
