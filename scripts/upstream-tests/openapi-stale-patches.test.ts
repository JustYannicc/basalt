import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Loaded by path, as the other upstream tests do, so Basalt's typecheck stays out of the framework.
type JsonObject = Record<string, unknown>;
type OpenapiPatch = { op: "add" | "remove" | "replace"; path: string; value?: unknown };
const implementation = resolve(fileURLToPath(new URL("../../.upstream/packages/apps/src/implementation/", import.meta.url)));
const { patchOpenapi, openapiToolNames } = (await import(pathToFileURL(join(implementation, "openapi-source.ts")).href)) as {
  patchOpenapi: (root: JsonObject, patches: readonly OpenapiPatch[], stale: (patch: OpenapiPatch) => void) => JsonObject;
  openapiToolNames: (options: JsonObject) => Promise<{ tools: { path: string }[]; skipped: unknown[] }>;
};
const { pointerToken } = (await import(pathToFileURL(join(implementation, "openapi-document.ts")).href)) as {
  pointerToken: (key: string) => string;
};

// The official ElevenLabs package as the catalog served it when its tools stopped loading.
const bytes = readFileSync(new URL("./fixtures/elevenlabs.catalog.json", import.meta.url));
const pkg = JSON.parse(bytes.toString()) as { package: string; files: { path: string; content: string }[] };
const file = (path: string) => pkg.files.find((entry) => entry.path === path)!.content;
// The shared schemas its parameters reference, from ElevenLabs' live document on 2026-11-03.
const parameterSchemas = JSON.parse(
  readFileSync(new URL("./fixtures/elevenlabs.parameter-schemas.json", import.meta.url), "utf8"),
) as JsonObject;

type Options = JsonObject & { patches: readonly OpenapiPatch[] };
/** The package's own OpenAPI options, loaded the way the app imports them. */
const options = (async () => {
  const directory = mkdtempSync(join(tmpdir(), "elevenlabs-"));
  try {
    writeFileSync(join(directory, "header-patches.json"), file("header-patches.json"));
    writeFileSync(join(directory, "openapi.ts"), file("openapi.ts"));
    return (await import(pathToFileURL(join(directory, "openapi.ts")).href)).options as Options;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

// ElevenLabs dropped these routes after the package's patches were generated.
const removed = ["/v1/speech-to-speech/{voice_id}", "/v1/speech-to-speech/{voice_id}/stream"];

/**
 * A document with every operation the package's parameter patches target, each still taking the
 * `xi-api-key` header those patches remove, except the routes ElevenLabs dropped.
 */
function currentDocument(patches: readonly OpenapiPatch[]) {
  const ok = { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } };
  const paths: Record<string, Record<string, JsonObject>> = { "/docs": { get: { responses: ok } } };
  for (const patch of patches) {
    const match = /^\/paths\/([^/]+)\/(\w+)\/parameters$/.exec(patch.path);
    if (!match || !Array.isArray(patch.value)) continue;
    const path = match[1]!.replaceAll("~1", "/").replaceAll("~0", "~");
    if (removed.includes(path)) continue;
    paths[path] = {
      ...paths[path],
      [match[2]!]: {
        parameters: [
          ...patch.value,
          { name: "xi-api-key", in: "header", required: false, schema: { type: "string" } },
        ],
        responses: ok,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "ElevenLabs", version: "1" },
    servers: [{ url: "https://api.elevenlabs.io" }],
    paths,
    components: { schemas: parameterSchemas },
  };
}

test("the ElevenLabs snapshot is the official package", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "7236a4734594f6aa04c2f1423f22ca191c0ac6f6c7311d795f0d533db4903905");
  assert.equal(pkg.package, "@executor.sh/elevenlabs");
});

test("patches for routes the live document dropped are skipped and the rest apply", async () => {
  const { patches } = await options;
  const stale: string[] = [];
  const patched = patchOpenapi(currentDocument(patches), patches, (patch) => stale.push(patch.path));
  assert.deepEqual(stale, removed.map((path) => `/paths/${pointerToken(path)}/post/parameters`));
  const paths = patched.paths as Record<string, Record<string, { parameters: { name: string }[] }>>;
  assert.equal(paths["/docs"], undefined);
  assert.deepEqual(patched.security, [{ xiApiKey: [] }]);
  const parameters = Object.values(paths).flatMap((item) => Object.values(item).flatMap((operation) => operation.parameters));
  assert.ok(parameters.length > 0);
  assert.ok(parameters.every((parameter) => parameter.name !== "xi-api-key"), "every applied patch removed the header");
});

test("every ElevenLabs tool loads from a document missing two patched routes", async () => {
  const resolved = await options;
  const document = currentDocument(resolved.patches);
  const operations = Object.values(document.paths).reduce((total, item) => total + Object.keys(item).length, 0);
  const result = await openapiToolNames({ ...resolved, fetch: async () => Response.json(document) });
  assert.equal(result.skipped.length, 0);
  // Every operation but the removed `/docs` redirect is a tool.
  assert.equal(result.tools.length, operations - 1);
});

test("only a dropped path item or operation makes a patch stale", () => {
  const document = {
    openapi: "3.1.0",
    paths: { "/v1/user": { get: { responses: {} } } },
    webhooks: { created: { post: { responses: {} } } },
  };
  const skipped = (patch: OpenapiPatch) => {
    const stale: OpenapiPatch[] = [];
    patchOpenapi(document, [patch], (each) => stale.push(each));
    return stale.length === 1;
  };
  assert.ok(skipped({ op: "replace", path: "/paths/~1v1~1gone/get/parameters", value: [] }));
  assert.ok(skipped({ op: "remove", path: "/paths/~1v1~1user/delete" }));
  assert.ok(skipped({ op: "add", path: "/webhooks/deleted/post/security", value: [] }));
  const refused = { reason: "invalid_definition" };
  const fails = (patch: OpenapiPatch) =>
    assert.throws(() => patchOpenapi(document, [patch], () => assert.fail("not stale")), refused, patch.path);
  // A field of an operation that still exists, such as its security, is never skipped.
  fails({ op: "replace", path: "/paths/~1v1~1user/get/security", value: [] });
  fails({ op: "replace", path: "/paths/~1v1~1user/get/requestBody/content", value: {} });
  // Neither is a missing container or anything outside path items, such as a security scheme.
  assert.throws(
    () => patchOpenapi({ openapi: "3.1.0" }, [{ op: "add", path: "/paths/~1x", value: {} }], () => assert.fail("not stale")),
    refused,
  );
  fails({ op: "add", path: "/components/securitySchemes/key", value: {} });
  fails({ op: "remove", path: "/info" });
  // Malformed patches fail before the walk.
  fails({ op: "replace", path: "/paths/~1v1~1user/get" });
  fails({ op: "add", path: "paths", value: {} });
  fails({ op: "replace", path: "/paths/~1v1~1gone/", value: [] });
});
