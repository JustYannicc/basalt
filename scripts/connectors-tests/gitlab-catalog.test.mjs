import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { servedFrameworkVersion } from "../../framework-release.ts";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { loadGitLabCatalogSource } from "./gitlab-catalog.mjs";

test("GitLab connector proof accepts the served framework and rejects changed source", async () => {
  let changed = false;
  const server = createServer(async (request, response) => {
    const result = await handleCatalog(new Request(`http://localhost${request.url}`));
    const source = await result.json();
    if (changed) source.files.find((file) => file.path === "index.ts").content += "\n// changed\n";
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(source));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const input = {
      root: fileURLToPath(new URL("../../", import.meta.url)),
      catalogOrigin: `http://127.0.0.1:${server.address().port}`,
    };
    const { source, provenance } = await loadGitLabCatalogSource(input);
    const manifest = JSON.parse(source.files.find((file) => file.path === "package.json").content);
    assert.equal(manifest.dependencies.apps, servedFrameworkVersion);
    assert.notEqual(manifest.dependencies.apps, provenance.appsVersion);
    changed = true;
    await assert.rejects(loadGitLabCatalogSource(input), /beyond its served framework/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
