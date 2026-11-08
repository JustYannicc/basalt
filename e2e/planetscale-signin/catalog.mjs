import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { appsVersion } from "../../.upstream/e2e/support/apps-release.ts";

/** PlanetScale's fixed origins, in the order they are replaced. Nothing else in the source changes. */
const origins = [
  "https://planetscale.com/docs",
  "https://api.planetscale.com",
  "https://app.planetscale.com",
  "https://auth.planetscale.com",
];

/**
 * The real catalog Worker with only its publisher replaced. PlanetScale's origins are fixed, so
 * the carried source is served with those URLs and credential hosts moved to the loopback service;
 * every other byte, including the provider, guidance and scope table, is what production serves.
 */
export async function startPlanetScaleCatalog(service) {
  const host = new URL(service).host;
  const entry = {
    id: "planetscale",
    package: "@executor.sh/planetscale",
    name: "PlanetScale",
    description: "PlanetScale.",
    auth: [
      { method: "token", kind: "secrets", label: "Service token" },
      { method: "oauth2", kind: "oauth2", label: "OAuth 2.0" },
    ],
    icons: [],
    source: "apps/planetscale.json",
  };
  const move = (content) => {
    let moved = content;
    for (const from of origins)
      moved = moved.replaceAll(from, from.endsWith("/docs") ? `${service}/docs` : service);
    return moved.replace(
      /hosts: \["api\.planetscale\.com", "app\.planetscale\.com", "auth\.planetscale\.com"\]/g,
      `hosts: [${JSON.stringify(host)}]`,
    );
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const result = await handleCatalog(new Request(url), async () =>
        Response.json({ version: 1, apps: [entry] }),
      );
      let body = await result.text();
      if (url.pathname === "/catalog/apps/planetscale.json" && result.ok) {
        const source = JSON.parse(body);
        const index = source.files.find((file) => file.path === "index.ts").content;
        assert.notEqual(move(index), index, "The carried source must name PlanetScale's origins");
        assert.match(move(index), new RegExp(`hosts: \\[${JSON.stringify(host)}\\]`));
        body = JSON.stringify({
          ...source,
          files: source.files.map((file) =>
            file.path === "package.json"
              ? {
                  ...file,
                  content: JSON.stringify({
                    ...JSON.parse(file.content),
                    dependencies: { apps: appsVersion },
                  }),
                }
              : { ...file, content: move(file.content) },
          ),
        });
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(body);
    } catch {
      response.writeHead(500);
      response.end("PlanetScale catalog fixture failed");
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
