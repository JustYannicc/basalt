import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { openCodexPreviewFixture } from "./codex-fixture.ts";
import { createNativePreviewSession } from "./preview-native.ts";
import { brand } from "../../brand.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));

test(
  "installed Codex uses synthetic Responses, real installer config and MCP while preserving existing ChatGPT auth",
  {
    skip: process.env.RUN_PREVIEW_CODEX_FIXTURE !== "1",
    timeout: 90_000,
  },
  async () => {
    const { build } = require("esbuild") as typeof import("esbuild");
    const bundle = await build({
      entryPoints: [new URL("../../src/setup/client.mjs", import.meta.url).pathname],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      write: false,
    });
    assert.equal(bundle.outputFiles.length, 1);
    const marker = "preview-native-synthetic-codex-ok";
    const fixture = await openCodexPreviewFixture(marker, brand.mcpServerName);
    let searches = 0;
    const server = createServer(async (request, response) => {
      if (request.url === "/setup/client.mjs" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(bundle.outputFiles[0]!.text);
        return;
      }
      if (
        request.url !== "/mcp" ||
        request.method !== "POST" ||
        request.headers.authorization !== "Bearer fixture-stage-tools-token"
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      let result: unknown;
      if (body.method === "initialize")
        result = {
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "preview-fixture", version: "1" },
        };
      else if (body.method === "tools/list")
        result = {
          tools: [
            {
              name: "search",
              description: "Search the fixture",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" }, limit: { type: "integer" } },
                required: ["query", "limit"],
              },
            },
          ],
        };
      else if (body.method === "tools/call") {
        assert.equal(body.params.name, "search");
        assert.deepEqual(body.params.arguments, { query: "pool", limit: 1 });
        searches++;
        result = { content: [{ type: "text", text: JSON.stringify({ items: [], remaining: 0 }) }] };
      } else result = {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    let session: Awaited<ReturnType<typeof createNativePreviewSession>> | undefined;
    try {
      session = await createNativePreviewSession({
        client: "codex",
        model: fixture.model,
        origin,
        modelOrigin: fixture.modelUrl,
        marker,
        codexAuthFile: fixture.authFile,
        payload: {
          version: 1,
          brand,
          instructions: "Synthetic fixture",
          credentials: {
            modelUrl: fixture.modelUrl,
            modelKey: fixture.modelKey,
            toolsUrl: `${origin}/mcp`,
            toolsToken: "fixture-stage-tools-token",
          },
        },
      });
      assert.deepEqual(await session.run(), {
        modelReplyMatched: true,
        toolCallObserved: true,
        chatgptAuthPreserved: true,
        refreshTokenUntouched: true,
      });
      assert.equal(searches, 1);
      assert.deepEqual(fixture.evidence(), {
        requests: 2,
        toolRequested: true,
        toolResultObserved: true,
        failed: false,
      });
      await session.undo();
    } finally {
      try {
        await session?.dispose();
      } finally {
        await fixture.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
);
