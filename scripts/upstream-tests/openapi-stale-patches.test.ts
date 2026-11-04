import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  currentDocument,
  elevenlabs,
  expectedTools,
  packageBytes,
  packageFile,
  packageSha256,
  removedRoutes,
} from "./fixtures/elevenlabs.ts";

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

type Options = JsonObject & { patches: readonly OpenapiPatch[] };
/** The package's own OpenAPI options, loaded the way the app imports them. */
const options = (async () => {
  const directory = mkdtempSync(join(tmpdir(), "elevenlabs-"));
  try {
    writeFileSync(join(directory, "header-patches.json"), packageFile("header-patches.json"));
    writeFileSync(join(directory, "openapi.ts"), packageFile("openapi.ts"));
    return (await import(pathToFileURL(join(directory, "openapi.ts")).href)).options as Options;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

test("the ElevenLabs snapshot is the official package", () => {
  assert.equal(createHash("sha256").update(packageBytes).digest("hex"), packageSha256);
  assert.equal(elevenlabs.package, "@executor.sh/elevenlabs");
});

test("patches for routes the live document dropped are skipped and the rest apply", async () => {
  const { patches } = await options;
  const stale: string[] = [];
  const patched = patchOpenapi(currentDocument(), patches, (patch) => stale.push(patch.path));
  assert.deepEqual(stale, removedRoutes.map((path) => `/paths/${pointerToken(path)}/post/parameters`));
  const paths = patched.paths as Record<string, Record<string, { parameters: { name: string }[] }>>;
  assert.equal(paths["/docs"], undefined);
  assert.deepEqual(patched.security, [{ xiApiKey: [] }]);
  const parameters = Object.values(paths).flatMap((item) => Object.values(item).flatMap((operation) => operation.parameters));
  assert.ok(parameters.length > 0);
  assert.ok(parameters.every((parameter) => parameter.name !== "xi-api-key"), "every applied patch removed the header");
});

test("every ElevenLabs tool loads from a document missing two patched routes", async () => {
  const resolved = await options;
  const document = currentDocument();
  const result = await openapiToolNames({ ...resolved, fetch: async () => Response.json(document) });
  assert.equal(result.skipped.length, 0);
  assert.equal(result.tools.length, expectedTools(document));
});

test("only a dropped path item or operation makes a patch stale", () => {
  const document = {
    openapi: "3.1.0",
    paths: { "/v1/user": { get: { responses: {} } } },
    webhooks: { created: { post: { responses: {} } } },
    "x-webhooks": {},
    components: { schemas: { Payload: { properties: { "": { type: "string" } } } } },
  };
  const skipped = (patch: OpenapiPatch) => {
    const stale: OpenapiPatch[] = [];
    patchOpenapi(document, [patch], (each) => stale.push(each));
    return stale.length === 1;
  };
  assert.ok(skipped({ op: "replace", path: "/paths/~1v1~1gone/get/parameters", value: [] }));
  assert.ok(skipped({ op: "remove", path: "/paths/~1v1~1user/delete" }));
  assert.ok(skipped({ op: "add", path: "/webhooks/deleted/post/security", value: [] }));
  // An operation the importer does not support still counts as one the provider dropped.
  assert.ok(skipped({ op: "replace", path: "/paths/~1v1~1user/trace/parameters", value: [] }));
  assert.ok(skipped({ op: "remove", path: "/paths/~1v1~1user/additionalOperations/COPY" }));
  assert.ok(skipped({ op: "add", path: "/x-webhooks/gone/post/security", value: [] }));
  // A property named with the empty string is a valid pointer target, not a malformed patch.
  assert.ok(!skipped({ op: "add", path: "/components/schemas/Payload/properties//description", value: "Note" }));
  const refused = { reason: "invalid_definition" };
  const fails = (patch: OpenapiPatch) =>
    assert.throws(() => patchOpenapi(document, [patch], () => assert.fail("not stale")), refused, patch.path);
  // A field of a path item or operation that still exists is never skipped, such as its security.
  fails({ op: "replace", path: "/paths/~1v1~1user/get/security", value: [] });
  fails({ op: "replace", path: "/paths/~1v1~1user/get/requestBody/content", value: {} });
  fails({ op: "replace", path: "/paths/~1v1~1user/parameters", value: [] });
  fails({ op: "replace", path: "/paths/~1v1~1user/servers/0", value: {} });
  fails({ op: "remove", path: "/paths/~1v1~1user/summary" });
  // A missing `additionalOperations` with no operation named is not a dropped operation.
  fails({ op: "remove", path: "/paths/~1v1~1user/additionalOperations" });
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
  // Even when it targets a dropped route.
  fails({ op: "copy" as never, path: "/paths/~1v1~1gone/get" });
  fails({ op: "remove", path: "/paths/~1v1~2gone/get" });
});
