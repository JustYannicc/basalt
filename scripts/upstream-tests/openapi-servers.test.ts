import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Loaded by path, as the other upstream tests do, so Basalt's typecheck stays out of the framework.
type JsonObject = Record<string, unknown>;
const framework = resolve(
  fileURLToPath(new URL("../../.upstream/packages/apps/", import.meta.url)),
);
const { compileOpenApiDocument } = (await import(
  pathToFileURL(join(framework, "src/implementation/openapi-compile.ts")).href
)) as {
  compileOpenApiDocument: (
    entry: { name: string },
    document: JsonObject,
    options?: { baseUrl?: string; allowedOrigin?: string },
  ) => unknown;
};
const { Effect } = (await import(
  pathToFileURL(createRequire(join(framework, "package.json")).resolve("effect")).href
)) as { Effect: { runPromise: (effect: unknown) => Promise<unknown> } };

/** One document server, one Path Item override and one Operation override on the same origin. */
const document = (): JsonObject => ({
  openapi: "3.1.0",
  info: { title: "Server overrides", version: "1" },
  servers: [{ url: "https://api.example.test" }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "x-api-key" } } },
  security: [{ key: [] }],
  paths: {
    "/root": { get: { operationId: "documentServer", responses: { 200: { description: "ok" } } } },
    "/v0/teams/me": {
      servers: [{ url: "https://api.example.test/path-server" }],
      get: { operationId: "pathServer", responses: { 200: { description: "ok" } } },
      post: {
        operationId: "operationServer",
        servers: [{ url: "https://api.example.test/operation-server" }],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});

const baseUrls = async (options: { baseUrl?: string } = {}) => {
  const compiled = (await Effect.runPromise(
    compileOpenApiDocument({ name: "Server overrides" }, document(), {
      allowedOrigin: "https://api.example.test",
      ...options,
    }),
  )) as { operations: { operationId: string; baseUrl: string }[] };
  return Object.fromEntries(compiled.operations.map((op) => [op.operationId, op.baseUrl]));
};

test("operation servers outrank path servers, which outrank the document's", async () => {
  assert.deepEqual(await baseUrls(), {
    documentServer: "https://api.example.test",
    pathServer: "https://api.example.test/path-server",
    operationServer: "https://api.example.test/operation-server",
  });
});

test("an explicit baseUrl still replaces every server the document declares", async () => {
  assert.deepEqual(await baseUrls({ baseUrl: "https://api.example.test/fixed" }), {
    documentServer: "https://api.example.test/fixed",
    pathServer: "https://api.example.test/fixed",
    operationServer: "https://api.example.test/fixed",
  });
});
