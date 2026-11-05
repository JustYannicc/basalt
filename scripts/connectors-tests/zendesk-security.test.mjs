import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { openapiToolNames } from "../../.upstream/packages/apps/dist/js/openapi.js";

const snapshot = JSON.parse(
  await readFile(new URL("../../src/catalog/zendesk/source.json", import.meta.url), "utf8"),
);

test("Zendesk imports both declared security schemes without accepting an unmapped credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-security-"));
  try {
    const options = snapshot.files.find((file) => file.path === "openapi.ts");
    assert.ok(options);
    const file = join(directory, "openapi.ts");
    await writeFile(file, options.content);
    const { optionsFor } = await import(pathToFileURL(file).href);
    const origin = "https://customer.zendesk.com";
    const document = {
      openapi: "3.0.3",
      info: { title: "Zendesk security alternatives", version: "1" },
      servers: [{ url: origin }],
      paths: Object.fromEntries(
        ["basicAuth", "oauth2", "unknown"].map((scheme, index) => [
          `/operation-${index}`,
          {
            get: {
              operationId: `operation${index}`,
              security: [{ [scheme]: [] }],
              responses: { 200: { description: "OK" } },
            },
          },
        ]),
      ),
      components: {
        securitySchemes: {
          basicAuth: { type: "http", scheme: "basic" },
          oauth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: `${origin}/oauth/authorizations/new`,
                tokenUrl: `${origin}/oauth/tokens`,
                scopes: {},
              },
            },
          },
          unknown: { type: "apiKey", in: "header", name: "x-unknown" },
        },
      },
    };
    const result = await openapiToolNames({
      ...optionsFor(origin),
      fetch: async () => Response.json(document),
    });
    assert.deepEqual(result.tools.map((tool) => tool.path).sort(), [
      "/operation-0",
      "/operation-1",
    ]);
    assert.deepEqual(
      result.skipped.map((tool) => tool.path),
      ["/operation-2"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
